import { events, idempotencyKeys, seen, sql } from '@outfitly/db';
import {
  type ClientEvent,
  type EventBatch,
  feedPageSchema,
  MAX_EVENT_BATCH,
  meSchema,
} from '@outfitly/shared';
import type { FastifyInstance } from 'fastify';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { deleteOldSeen } from '../src/events.ts';
import { EVENTS_PER_MINUTE } from '../src/routes/events.ts';
import { createAuthor, createLogin, createLooks } from './feed-fixtures.ts';
import { buildTestApp, createTestContext, type TestContext } from './helpers.ts';

let ctx: TestContext;
let app: FastifyInstance;
let lookIds: string[] = [];

beforeAll(async () => {
  ctx = await createTestContext();
  app = await buildTestApp(ctx);
  await app.ready();
  const authors = [await createAuthor(ctx.db, 'poster.a'), await createAuthor(ctx.db, 'poster.b')];
  lookIds = await createLooks(
    ctx.db,
    Array.from({ length: 12 }, (_, i) => ({ authorId: authors[i % 2] ?? '' })),
  );
});

afterAll(async () => {
  await app.close();
  await ctx.close();
});

function look(i: number): string {
  const id = lookIds[i];
  if (!id) throw new Error(`no look ${String(i)}`);
  return id;
}

function impression(lookId: string, change: Partial<ClientEvent> = {}): ClientEvent {
  return {
    id: crypto.randomUUID(),
    name: 'impression',
    lookId,
    position: 3,
    source: 'feed_for_you',
    occurredAt: new Date().toISOString(),
    ...change,
  };
}

function batch(list: ClientEvent[], sessionId = crypto.randomUUID()): EventBatch {
  return { sessionId, platform: 'android', events: list };
}

async function send(body: EventBatch, headers: Record<string, string> = {}) {
  return app.inject({ method: 'POST', url: '/v1/events', headers, payload: body });
}

async function stored(id: string) {
  return ctx.db
    .select()
    .from(events)
    .where(sql`${events.id} = ${id}`);
}

async function loggedIn() {
  const { token } = await createLogin(ctx.db);
  const res = await app.inject({
    method: 'POST',
    url: '/v1/session',
    headers: { authorization: `Bearer ${token}`, 'idempotency-key': crypto.randomUUID() },
    payload: {},
  });
  const me = meSchema.parse(res.json());
  if (!me.activeProfileId) throw new Error('no active profile');
  const headers = {
    authorization: `Bearer ${token}`,
    'x-profile-id': me.activeProfileId,
    'idempotency-key': crypto.randomUUID(),
  };
  return { token, profileId: me.activeProfileId, headers };
}

describe('POST /v1/events', () => {
  it('stores a logged-out impression with its session, place, source and phone time', async () => {
    const occurredAt = new Date(Date.now() - 60_000).toISOString();
    const event = impression(look(0), { occurredAt });
    const body = batch([event]);
    const res = await send(body);
    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({ accepted: 1 });

    const [row] = await stored(event.id);
    expect(row).toMatchObject({
      name: 'impression',
      profileId: null,
      sessionId: body.sessionId,
      lookId: look(0),
      position: 3,
      source: 'feed_for_you',
      platform: 'android',
    });
    expect(row?.createdAt.toISOString()).toBe(occurredAt);
  });

  it('stores a resent batch only once, and a repeated id in one batch once', async () => {
    const event = impression(look(1));
    const body = batch([event, event]);
    expect((await send(body)).json()).toEqual({ accepted: 1 });
    expect((await send(body)).json()).toEqual({ accepted: 0 });
    expect(await stored(event.id)).toHaveLength(1);
  });

  it('skips looks that do not exist and times far from now', async () => {
    const day = 24 * 60 * 60 * 1000;
    const unknown = impression(crypto.randomUUID());
    const stale = impression(look(2), { occurredAt: new Date(Date.now() - 8 * day).toISOString() });
    const future = impression(look(2), {
      occurredAt: new Date(Date.now() + 30 * 60_000).toISOString(),
    });
    const fine = impression(look(2));
    const res = await send(batch([unknown, stale, future, fine]));
    expect(res.json()).toEqual({ accepted: 1 });
    expect(await stored(unknown.id)).toHaveLength(0);
    expect(await stored(stale.id)).toHaveLength(0);
    expect(await stored(future.id)).toHaveLength(0);
  });

  it('skips looks that are not public', async () => {
    const author = await createAuthor(ctx.db, 'poster.hidden');
    const [hidden, draft] = await createLooks(ctx.db, [
      { authorId: author, status: 'hidden' },
      { authorId: author, status: 'draft' },
    ]);
    const res = await send(batch([impression(hidden ?? ''), impression(draft ?? '')]));
    expect(res.json()).toEqual({ accepted: 0 });
  });

  it(`refuses more than ${String(MAX_EVENT_BATCH)} events, and skips events it can't read one by one`, async () => {
    const tooMany = Array.from({ length: MAX_EVENT_BATCH + 1 }, () => impression(look(0)));
    expect((await send(batch(tooMany))).statusCode).toBe(400);
    // An unknown name or source (e.g. from a newer app) is skipped; the rest of the batch counts.
    const click = { ...impression(look(0)), name: 'click' } as unknown as ClientEvent;
    const elsewhere = { ...impression(look(1)), source: 'somewhere' } as unknown as ClientEvent;
    const good = impression(look(2));
    const res = await send(batch([click, elsewhere, good]));
    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({ accepted: 1 });
    expect((await send(batch([click]))).json()).toEqual({ accepted: 0 });
  });

  it('logged in: stores the active profile and marks the looks seen', async () => {
    const { profileId, headers } = await loggedIn();
    const event = impression(look(3));
    expect((await send(batch([event]), headers)).json()).toEqual({ accepted: 1 });
    const [row] = await stored(event.id);
    expect(row?.profileId).toBe(profileId);

    const marks = await ctx.db
      .select()
      .from(seen)
      .where(sql`${seen.profileId} = ${profileId}`);
    expect(marks.map((m) => m.lookId)).toEqual([look(3)]);
  });

  it('keeps the latest "seen" time when an older impression arrives later', async () => {
    const { profileId, headers } = await loggedIn();
    const recent = new Date(Date.now() - 60_000).toISOString();
    const older = new Date(Date.now() - 60 * 60_000).toISOString();
    await send(batch([impression(look(4), { occurredAt: recent })]), headers);
    await send(batch([impression(look(4), { occurredAt: older })]), {
      ...headers,
      'idempotency-key': crypto.randomUUID(),
    });
    const [mark] = await ctx.db
      .select()
      .from(seen)
      .where(sql`${seen.profileId} = ${profileId}`);
    expect(mark?.lastSeenAt.toISOString()).toBe(recent);
  });

  it('logged in: For You leaves out what the profile has seen', async () => {
    const { token, profileId, headers } = await loggedIn();
    const forYou = async () => {
      const res = await app.inject({
        method: 'GET',
        url: '/v1/feed/for-you',
        headers: { authorization: `Bearer ${token}`, 'x-profile-id': profileId },
      });
      return feedPageSchema.parse(res.json()).items.map((c) => c.id);
    };
    const before = await forYou();
    const shown = before.slice(0, 5);
    expect(shown).toHaveLength(5);
    await send(batch(shown.map((id, i) => impression(id, { position: i }))), headers);
    const after = await forYou();
    expect(after.filter((id) => shown.includes(id))).toEqual([]);
    expect(after.length).toBe(before.length - 5);
  });

  it('skips the Idempotency-Key table (event ids already dedupe) but still needs the header', async () => {
    const { headers } = await loggedIn();
    const key = headers['idempotency-key'];
    expect((await send(batch([impression(look(5))]), headers)).statusCode).toBe(200);
    const rows = await ctx.db
      .select()
      .from(idempotencyKeys)
      .where(sql`${idempotencyKeys.key} = ${key}`);
    expect(rows).toHaveLength(0);

    const res = await send(batch([impression(look(5))]), {
      authorization: headers.authorization,
      'x-profile-id': headers['x-profile-id'],
    });
    expect(res.statusCode).toBe(400);
    expect(res.json()).toMatchObject({ error: { code: 'idempotency_key_required' } });
  });

  it("refuses to act as a profile the login doesn't own", async () => {
    const { headers } = await loggedIn();
    const other = await loggedIn();
    const res = await send(batch([impression(look(6))]), {
      ...headers,
      'x-profile-id': other.profileId,
    });
    expect(res.statusCode).toBe(403);
  });
});

describe('POST /v1/events rate limit', () => {
  it(`allows ${String(EVENTS_PER_MINUTE.loggedOut)} batches a minute logged out, more logged in`, async () => {
    const limited = await buildTestApp(ctx, { RATE_LIMIT_PER_MINUTE: 1000 });
    await limited.ready();
    try {
      const post = (headers: Record<string, string>) =>
        limited.inject({
          method: 'POST',
          url: '/v1/events',
          headers: { 'x-forwarded-for': '203.0.113.9', ...headers },
          payload: batch([impression(look(9))]),
        });
      const codes: number[] = [];
      for (let i = 0; i <= EVENTS_PER_MINUTE.loggedOut; i++)
        codes.push((await post({})).statusCode);
      expect(codes.slice(0, -1).every((c) => c === 200)).toBe(true);
      expect(codes.at(-1)).toBe(429);

      const { headers } = await loggedIn();
      expect((await post(headers)).statusCode).toBe(200);
    } finally {
      await limited.close();
    }
  });
});

describe('deleteOldSeen', () => {
  it('deletes only "seen" rows older than 7 days', async () => {
    const { profileId } = await loggedIn();
    const day = 24 * 60 * 60 * 1000;
    await ctx.db.insert(seen).values([
      { profileId, lookId: look(7), lastSeenAt: new Date(Date.now() - 8 * day) },
      { profileId, lookId: look(8), lastSeenAt: new Date(Date.now() - 6 * day) },
    ]);
    expect(await deleteOldSeen(ctx.db)).toBeGreaterThanOrEqual(1);
    const left = await ctx.db
      .select()
      .from(seen)
      .where(sql`${seen.profileId} = ${profileId}`);
    expect(left.map((m) => m.lookId)).toEqual([look(8)]);
  });
});
