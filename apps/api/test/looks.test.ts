import { and, eq, follows, lookMedia, media, sql } from '@outfitly/db';
import {
  FEED_PAGE_SIZE,
  type FeedPage,
  feedPageSchema,
  IDEMPOTENT_REPLAY_HEADER,
  lookDetailSchema,
  MAX_SIMILAR_LOOKS,
  meSchema,
} from '@outfitly/shared';
import type { FastifyInstance } from 'fastify';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { showableLook } from '../src/feed/cards.ts';
import { createAuthor, createLogin, createLook, createLooks } from './feed-fixtures.ts';
import { buildTestApp, createTestContext, type TestContext } from './helpers.ts';

let ctx: TestContext;
let app: FastifyInstance;
let author: string;

beforeAll(async () => {
  ctx = await createTestContext();
  app = await buildTestApp(ctx);
  await app.ready();
  author = await createAuthor(ctx.db, 'look.author');
});

afterAll(async () => {
  await app.close();
  await ctx.close();
});

type Method = 'GET' | 'PUT' | 'DELETE';

function call(method: Method, url: string, token?: string, key = crypto.randomUUID()) {
  return app.inject({
    method,
    url,
    headers: {
      ...(token ? { authorization: `Bearer ${token}` } : {}),
      ...(method === 'GET' ? {} : { 'idempotency-key': key }),
    },
    ...(method === 'PUT' ? { payload: {} } : {}),
  });
}

async function viewer(): Promise<{ token: string; profileId: string }> {
  const { token } = await createLogin(ctx.db);
  const res = await app.inject({
    method: 'POST',
    url: '/v1/session',
    headers: { authorization: `Bearer ${token}`, 'idempotency-key': crypto.randomUUID() },
    payload: {},
  });
  const me = meSchema.parse(res.json());
  if (!me.activeProfileId) throw new Error('no active profile');
  return { token, profileId: me.activeProfileId };
}

/** Adds a photo to a look at `position` (ready unless said otherwise). */
async function addPhoto(lookId: string, position: number, ready = true): Promise<string> {
  const mediaId = crypto.randomUUID();
  await ctx.db.insert(media).values({
    id: mediaId,
    ownerProfileId: author,
    status: ready ? 'ready' : 'processing',
    originalKey: `originals/${mediaId}`,
    ...(ready
      ? {
          key1080: `m/${mediaId}/1080.webp`,
          key600: `m/${mediaId}/600.webp`,
          key300: `m/${mediaId}/300.webp`,
          width: 1080,
          height: 1350,
          thumbhash: 'k0oGLQaSVsN0BVhn2oq2Z5SQUQcZ',
          dominantColor: '#806040',
        }
      : {}),
  });
  await ctx.db.insert(lookMedia).values({ lookId, mediaId, position });
  return mediaId;
}

describe('GET /v1/looks/:lookId', () => {
  it('shows a look to anyone: its ready photos in order, the poster and the caption', async () => {
    const look = await createLook(ctx.db, { authorId: author });
    await ctx.db.execute(sql`UPDATE looks SET caption = 'Camel coat' WHERE id = ${look}`);
    const second = await addPhoto(look, 1);
    await addPhoto(look, 2, false); // still processing: left out
    const third = await addPhoto(look, 3);

    const res = await call('GET', `/v1/looks/${look}`);
    expect(res.statusCode, res.body).toBe(200);
    const detail = lookDetailSchema.parse(res.json());
    expect(detail).toMatchObject({
      id: look,
      caption: 'Camel coat',
      saved: false,
      itemCount: 0,
      author: {
        id: author,
        handle: 'look.author',
        displayName: null,
        avatar: null,
        isVerified: false,
        isFollowing: false,
      },
    });
    expect(detail.photos).toHaveLength(3);
    expect(detail.photos[0]?.width).toBe(1080);
    expect(detail.photos[1]?.urls[600]).toBe(`https://img.test/m/${second}/600.webp`);
    expect(detail.photos[2]?.urls[600]).toBe(`https://img.test/m/${third}/600.webp`);
  });

  it("says whether the viewer saved it and follows the poster, and shows the poster's photo", async () => {
    const me = await viewer();
    const look = await createLook(ctx.db, { authorId: author });
    await call('PUT', `/v1/saves/${look}`, me.token);
    await call('PUT', `/v1/follows/${author}`, me.token);
    const avatar = await addPhoto(await createLook(ctx.db, { authorId: author }), 1);
    await ctx.db.execute(sql`UPDATE profiles SET avatar_media_id = ${avatar} WHERE id = ${author}`);

    const detail = lookDetailSchema.parse(
      (await call('GET', `/v1/looks/${look}`, me.token)).json(),
    );
    expect(detail.saved).toBe(true);
    expect(detail.author.isFollowing).toBe(true);
    expect(detail.author.avatar?.urls[300]).toBe(`https://img.test/m/${avatar}/300.webp`);
    // Someone else sees neither.
    const other = await viewer();
    const theirs = lookDetailSchema.parse(
      (await call('GET', `/v1/looks/${look}`, other.token)).json(),
    );
    expect(theirs.saved).toBe(false);
    expect(theirs.author.isFollowing).toBe(false);
    await ctx.db.execute(sql`UPDATE profiles SET avatar_media_id = NULL WHERE id = ${author}`);
  });

  it("is 404 for looks that can't be shown", async () => {
    const gone = await createAuthor(ctx.db, 'look.gone');
    const ids = [
      await createLook(ctx.db, { authorId: author, status: 'hidden' }),
      await createLook(ctx.db, { authorId: author, status: 'draft' }),
      await createLook(ctx.db, { authorId: author, cover: 'processing' }),
      await createLook(ctx.db, { authorId: gone }),
      crypto.randomUUID(),
    ];
    await ctx.db.execute(sql`UPDATE profiles SET deleted_at = now() WHERE id = ${gone}`);
    for (const id of ids) {
      expect((await call('GET', `/v1/looks/${id}`)).statusCode).toBe(404);
      expect((await call('GET', `/v1/looks/${id}/similar`)).statusCode).toBe(404);
    }
    expect((await call('GET', '/v1/looks/not-a-uuid')).statusCode).toBe(400);
  });
});

describe('GET /v1/looks/:lookId/similar', () => {
  let base: string;
  let ids: string[];

  beforeAll(async () => {
    const other = await createAuthor(ctx.db, 'similar.author');
    // The look: party + winter. Two share both tags, one shares one, the rest none.
    base = await createLook(ctx.db, {
      authorId: author,
      occasions: ['party'],
      seasons: ['winter'],
    });
    ids = await createLooks(ctx.db, [
      { authorId: other, occasions: ['party'], seasons: ['winter'], popularity: 0.01 },
      { authorId: other, occasions: ['party'], seasons: ['winter'], popularity: 0.02 },
      { authorId: other, occasions: ['work'], seasons: ['winter'], popularity: 5 },
      { authorId: other, occasions: ['party'], seasons: ['winter'], status: 'hidden' },
    ]);
  });

  async function page(cursor?: string | null): Promise<FeedPage> {
    const query = cursor ? `?cursor=${encodeURIComponent(cursor)}` : '';
    const res = await call('GET', `/v1/looks/${base}/similar${query}`);
    expect(res.statusCode, res.body).toBe(200);
    return feedPageSchema.parse(res.json());
  }

  it('puts the looks sharing the most tags first, then the most popular, never the look itself', async () => {
    const first = await page();
    const [bothLow, bothHigh, oneTag, hidden] = ids;
    expect(first.items.slice(0, 3).map((c) => c.id)).toEqual([bothHigh, bothLow, oneTag]);
    expect(first.items.map((c) => c.id)).not.toContain(base);
    expect(first.items.map((c) => c.id)).not.toContain(hidden);
  });

  it(`pages 20 at a time without repeats and stops at ${String(MAX_SIMILAR_LOOKS)}`, async () => {
    await createLooks(
      ctx.db,
      Array.from({ length: MAX_SIMILAR_LOOKS + 30 }, (_, i) => ({
        authorId: author,
        popularity: (i % 7) / 10,
        hoursAgo: 100 + (i % 5), // ties on time, so the id breaks them
      })),
    );
    const pages = [await page()];
    while (pages.at(-1)?.nextCursor) {
      pages.push(await page(pages.at(-1)?.nextCursor));
      if (pages.length > 20) throw new Error('never ends');
    }
    const all = pages.flatMap((p) => p.items.map((c) => c.id));
    expect(pages[0]?.items).toHaveLength(FEED_PAGE_SIZE);
    expect(all).toHaveLength(MAX_SIMILAR_LOOKS);
    // Page by page gives exactly the top of the full ranking: nothing skipped or repeated.
    const { rows } = await ctx.db.execute<{ id: string }>(sql`
      SELECT l.id FROM looks l, looks b
       WHERE b.id = ${base} AND l.id <> b.id AND ${showableLook(sql`l`)}
       ORDER BY cardinality(ARRAY(SELECT unnest(l.occasion_tags::text[] || l.season_tags::text[])
                                  INTERSECT SELECT unnest(b.occasion_tags::text[] || b.season_tags::text[]))) DESC,
                l.popularity_score DESC, l.published_at DESC, l.id DESC
       LIMIT ${MAX_SIMILAR_LOOKS}`);
    expect(all).toEqual(rows.map((r) => r.id));
  });

  it('refuses a cursor that is broken or past the end', async () => {
    const forged = Buffer.from(
      JSON.stringify({ s: 0, p: 0, t: '2026-01-01T00:00:00.000000Z', id: base, n: 999 }),
    ).toString('base64url');
    for (const cursor of ['nonsense', forged]) {
      const res = await call('GET', `/v1/looks/${base}/similar?cursor=${cursor}`);
      expect(res.statusCode).toBe(400);
    }
  });
});

describe('PUT / DELETE /v1/follows/:profileId', () => {
  async function followRows(followerId: string) {
    return ctx.db
      .select()
      .from(follows)
      .where(and(eq(follows.followerProfileId, followerId), eq(follows.followedProfileId, author)));
  }

  it('follows once however often, unfollows, and follows again on the same row', async () => {
    const me = await viewer();
    const first = await call('PUT', `/v1/follows/${author}`, me.token);
    expect(first.statusCode, first.body).toBe(200);
    expect(first.json()).toEqual({ profileId: author, following: true });
    await Promise.all([
      call('PUT', `/v1/follows/${author}`, me.token),
      call('PUT', `/v1/follows/${author}`, me.token),
    ]);
    expect(await followRows(me.profileId)).toHaveLength(1);

    const undone = await call('DELETE', `/v1/follows/${author}`, me.token);
    expect(undone.json()).toEqual({ profileId: author, following: false });
    expect((await call('DELETE', `/v1/follows/${author}`, me.token)).statusCode).toBe(200);
    expect((await followRows(me.profileId))[0]?.deletedAt).not.toBeNull();

    await call('PUT', `/v1/follows/${author}`, me.token);
    const rows = await followRows(me.profileId);
    expect(rows).toHaveLength(1);
    expect(rows[0]?.deletedAt).toBeNull();
  });

  it('refuses yourself, unknown or deleted profiles and logged-out callers; replays a retry', async () => {
    const me = await viewer();
    const closed = await createAuthor(ctx.db, 'follow.closed');
    await ctx.db.execute(sql`UPDATE profiles SET deleted_at = now() WHERE id = ${closed}`);
    expect((await call('PUT', `/v1/follows/${closed}`, me.token)).statusCode).toBe(404);
    expect((await call('PUT', `/v1/follows/${me.profileId}`, me.token)).statusCode).toBe(400);
    expect((await call('PUT', `/v1/follows/${crypto.randomUUID()}`, me.token)).statusCode).toBe(
      404,
    );
    expect((await call('PUT', `/v1/follows/${author}`)).statusCode).toBe(401);
    const key = crypto.randomUUID();
    await call('PUT', `/v1/follows/${author}`, me.token, key);
    const retry = await call('PUT', `/v1/follows/${author}`, me.token, key);
    expect(retry.statusCode).toBe(200);
    expect(retry.headers[IDEMPOTENT_REPLAY_HEADER]).toBe('true');
  });
});
