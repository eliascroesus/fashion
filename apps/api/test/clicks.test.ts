import { clicks, idempotencyKeys, lookItems, offers, products, sql } from '@outfitly/db';
import {
  type ClickBatch,
  type ClientClick,
  lookDetailSchema,
  MAX_CLICK_BATCH,
  meSchema,
} from '@outfitly/shared';
import type { FastifyInstance } from 'fastify';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { CLICKS_PER_MINUTE } from '../src/routes/clicks.ts';
import { createAuthor, createLogin, createLook } from './feed-fixtures.ts';
import { buildTestApp, createTestContext, type TestContext } from './helpers.ts';

let ctx: TestContext;
let app: FastifyInstance;
let author: string;
let lookId: string;
let offerId: string;
/** The poster's link as pasted, affiliate tags and all. */
const POSTED = 'https://www.shop.test/p/coat?utm_source=outfitly&aff=poster-123&x=a%20b';

beforeAll(async () => {
  ctx = await createTestContext();
  app = await buildTestApp(ctx);
  await app.ready();
  author = await createAuthor(ctx.db, 'clicks.author');
  lookId = await createLook(ctx.db, { authorId: author });
  offerId = await piece(lookId, POSTED);
});

afterAll(async () => {
  await app.close();
  await ctx.close();
});

/** A verified piece on the look, with its own product and shop link. Returns the offer id. */
async function piece(onLook: string, url = `https://www.shop.test/p/${crypto.randomUUID()}`) {
  const productId = crypto.randomUUID();
  await ctx.db.insert(products).values({ id: productId, name: 'Wool coat', brand: 'Acme' });
  const id = crypto.randomUUID();
  await ctx.db.insert(offers).values({
    id,
    productId,
    url,
    pageUrl: 'https://www.shop.test/p/coat',
    priceMinor: 129900,
    currency: 'SEK',
    stock: 'in_stock',
  });
  await ctx.db.insert(lookItems).values({ lookId: onLook, offerId: id, status: 'verified' });
  return id;
}

function click(change: Partial<ClientClick> = {}): ClientClick {
  return {
    id: crypto.randomUUID(),
    lookId,
    offerId,
    source: 'feed_for_you',
    position: 4,
    ...change,
  };
}

function batch(list: ClientClick[], sessionId = crypto.randomUUID()): ClickBatch {
  return { sessionId, platform: 'ios', clicks: list };
}

async function send(body: ClickBatch, headers: Record<string, string> = {}) {
  return app.inject({ method: 'POST', url: '/v1/clicks', headers, payload: body });
}

async function rowsOf(id: string) {
  return ctx.db
    .select()
    .from(clicks)
    .where(sql`${clicks.id} = ${id}`);
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
  return { profileId: me.activeProfileId, headers };
}

describe('POST /v1/clicks', () => {
  it('stores a logged-out tap with its session, look, link, poster, place and list', async () => {
    const tap = click();
    const sessionId = crypto.randomUUID();
    const res = await send(batch([tap], sessionId));
    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({ accepted: 1 });
    const [row] = await rowsOf(tap.id);
    expect(row).toMatchObject({
      id: tap.id,
      profileId: null,
      sessionId,
      lookId,
      offerId,
      authorProfileId: author,
      position: 4,
      source: 'feed_for_you',
      platform: 'ios',
    });
  });

  it('logged in: stores the active profile as well as the session', async () => {
    const { profileId, headers } = await loggedIn();
    const tap = click({ source: null, position: null });
    expect((await send(batch([tap]), headers)).json()).toEqual({ accepted: 1 });
    const [row] = await rowsOf(tap.id);
    expect(row).toMatchObject({ profileId, position: null, source: null });
    expect(row?.sessionId).not.toBeNull();
  });

  it('stores one row per tap, however often it is sent', async () => {
    const tap = click();
    const body = batch([tap]);
    // The phone resending after a lost answer, at the same time as a retry…
    const results = await Promise.all(Array.from({ length: 5 }, () => send(body)));
    expect(results.map((r) => r.statusCode)).toEqual([200, 200, 200, 200, 200]);
    expect(results.reduce((n, r) => n + r.json<{ accepted: number }>().accepted, 0)).toBe(1);
    // …and later again, and twice inside one batch.
    expect((await send(batch([tap, tap]))).json()).toEqual({ accepted: 0 });
    expect(await rowsOf(tap.id)).toHaveLength(1);
  });

  it('two taps are two clicks, even on the same piece', async () => {
    const first = click();
    const second = click();
    expect((await send(batch([first, second]))).json()).toEqual({ accepted: 2 });
    expect(await rowsOf(first.id)).toHaveLength(1);
    expect(await rowsOf(second.id)).toHaveLength(1);
  });

  it("skips a shop link that isn't a piece of that look, and unknown looks", async () => {
    const otherLook = await createLook(ctx.db, { authorId: author });
    const elsewhere = await piece(otherLook);
    const wrongLook = click({ offerId: elsewhere });
    const noLook = click({ lookId: crypto.randomUUID() });
    const noOffer = click({ offerId: crypto.randomUUID() });
    const res = await send(batch([wrongLook, noLook, noOffer]));
    expect(res.json()).toEqual({ accepted: 0 });
    for (const tap of [wrongLook, noLook, noOffer]) expect(await rowsOf(tap.id)).toHaveLength(0);
  });

  it('keeps a tap that waited on the phone while the piece was taken off the look', async () => {
    const gone = await piece(lookId);
    await ctx.db.execute(
      sql`UPDATE look_items SET deleted_at = now() WHERE offer_id = ${gone} AND look_id = ${lookId}`,
    );
    const tap = click({ offerId: gone });
    expect((await send(batch([tap]))).json()).toEqual({ accepted: 1 });
  });

  it('takes the poster from the look, never from the app', async () => {
    const tap = { ...click(), authorProfileId: crypto.randomUUID() } as ClientClick;
    expect((await send(batch([tap]))).statusCode).toBe(200);
    const [row] = await rowsOf(tap.id);
    expect(row?.authorProfileId).toBe(author);
  });

  it(`refuses more than ${String(MAX_CLICK_BATCH)} clicks and unknown lists`, async () => {
    const full = Array.from({ length: MAX_CLICK_BATCH + 1 }, () => click());
    expect((await send(batch(full))).statusCode).toBe(400);
    const odd = { ...click(), source: 'somewhere' } as unknown as ClientClick;
    expect((await send(batch([odd]))).statusCode).toBe(400);
  });

  it('skips the Idempotency-Key table (click ids already dedupe) but still needs the header', async () => {
    const { headers } = await loggedIn();
    const key = headers['idempotency-key'];
    expect((await send(batch([click()]), headers)).statusCode).toBe(200);
    const keys = await ctx.db
      .select()
      .from(idempotencyKeys)
      .where(sql`${idempotencyKeys.key} = ${key}`);
    expect(keys).toHaveLength(0);

    const res = await send(batch([click()]), {
      authorization: headers.authorization,
      'x-profile-id': headers['x-profile-id'],
    });
    expect(res.statusCode).toBe(400);
    expect(res.json()).toMatchObject({ error: { code: 'idempotency_key_required' } });
  });

  it("refuses to act as a profile the login doesn't own", async () => {
    const { headers } = await loggedIn();
    const other = await loggedIn();
    const res = await send(batch([click()]), { ...headers, 'x-profile-id': other.profileId });
    expect(res.statusCode).toBe(403);
  });

  it('gives the app the link exactly as posted, so Shop keeps the affiliate tags', async () => {
    const res = await app.inject({ method: 'GET', url: `/v1/looks/${lookId}` });
    expect(res.statusCode).toBe(200);
    const look = lookDetailSchema.parse(res.json());
    const shown = look.items.find((i) => i.offerId === offerId);
    expect(shown?.url).toBe(POSTED);
  });
});

describe('POST /v1/clicks rate limit', () => {
  it(`allows ${String(CLICKS_PER_MINUTE.loggedOut)} taps a minute logged out, more logged in`, async () => {
    const limited = await buildTestApp(ctx, { RATE_LIMIT_PER_MINUTE: 1000 });
    await limited.ready();
    try {
      const post = (headers: Record<string, string>) =>
        limited.inject({
          method: 'POST',
          url: '/v1/clicks',
          headers: { 'x-forwarded-for': '203.0.113.17', ...headers },
          payload: batch([click()]),
        });
      const codes: number[] = [];
      for (let i = 0; i <= CLICKS_PER_MINUTE.loggedOut; i++)
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
