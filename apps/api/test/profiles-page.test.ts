import { sql } from '@outfitly/db';
import { feedPageSchema, meSchema, profilePageSchema } from '@outfitly/shared';
import type { FastifyInstance } from 'fastify';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createAuthor, createLogin, createLook, createLooks } from './feed-fixtures.ts';
import { buildTestApp, createTestContext, type TestContext } from './helpers.ts';

let ctx: TestContext;
let app: FastifyInstance;

beforeAll(async () => {
  ctx = await createTestContext();
  app = await buildTestApp(ctx);
  await app.ready();
});

afterAll(async () => {
  await app.close();
  await ctx.close();
});

function call(method: 'GET' | 'PUT' | 'DELETE', url: string, token?: string) {
  return app.inject({
    method,
    url,
    headers: {
      ...(token ? { authorization: `Bearer ${token}` } : {}),
      ...(method === 'GET' ? {} : { 'idempotency-key': crypto.randomUUID() }),
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

async function page(profileId: string, token?: string) {
  const res = await call('GET', `/v1/profiles/${profileId}`, token);
  expect(res.statusCode).toBe(200);
  return profilePageSchema.parse(res.json());
}

describe('profile page', () => {
  it('shows counts of showable looks and of followers and following that still exist', async () => {
    const author = await createAuthor(ctx.db, 'page.author');
    await ctx.db.execute(
      sql`UPDATE profiles SET display_name = 'Page Author', is_verified = true WHERE id = ${author}`,
    );
    await createLooks(ctx.db, [
      { authorId: author },
      { authorId: author },
      { authorId: author },
      { authorId: author, status: 'hidden' },
      { authorId: author, status: 'draft' },
      { authorId: author, cover: 'processing' },
    ]);
    const fan = await viewer();
    const leaving = await viewer();
    const undone = await viewer();
    for (const v of [fan, leaving, undone]) {
      expect((await call('PUT', `/v1/follows/${author}`, v.token)).statusCode).toBe(200);
    }
    await call('DELETE', `/v1/follows/${author}`, undone.token);
    await ctx.db.execute(
      sql`UPDATE profiles SET deleted_at = now() WHERE id = ${leaving.profileId}`,
    );
    const followed = await createAuthor(ctx.db, 'page.followed');
    const closed = await createAuthor(ctx.db, 'page.closed');
    await ctx.db.execute(sql`
      INSERT INTO follows (follower_profile_id, followed_profile_id)
      VALUES (${author}, ${followed}), (${author}, ${closed})`);
    await ctx.db.execute(sql`UPDATE profiles SET deleted_at = now() WHERE id = ${closed}`);

    expect(await page(author)).toEqual({
      id: author,
      handle: 'page.author',
      displayName: 'Page Author',
      avatar: null,
      isVerified: true,
      isFollowing: false,
      counts: { looks: 3, followers: 1, following: 1 },
    });
    expect((await page(author, fan.token)).isFollowing).toBe(true);
    expect((await page(author, undone.token)).isFollowing).toBe(false);
  });

  it('is 404 for a deleted or unknown profile, and 400 for a bad id', async () => {
    const gone = await createAuthor(ctx.db, 'page.gone');
    await ctx.db.execute(sql`UPDATE profiles SET deleted_at = now() WHERE id = ${gone}`);
    expect((await call('GET', `/v1/profiles/${gone}`)).statusCode).toBe(404);
    expect((await call('GET', `/v1/profiles/${gone}/looks`)).statusCode).toBe(404);
    expect((await call('GET', `/v1/profiles/${crypto.randomUUID()}`)).statusCode).toBe(404);
    expect((await call('GET', '/v1/profiles/nope')).statusCode).toBe(400);
  });
});

describe("a profile's looks", () => {
  it('come newest first, 20 per page, without repeats or hidden looks', async () => {
    const author = await createAuthor(ctx.db, 'page.many');
    const ids = await createLooks(
      ctx.db,
      Array.from({ length: 25 }, (_, i) => ({ authorId: author, hoursAgo: i + 1 })),
    );
    const hidden = await createLook(ctx.db, { authorId: author, status: 'hidden', hoursAgo: 0.5 });
    const first = feedPageSchema.parse((await call('GET', `/v1/profiles/${author}/looks`)).json());
    expect(first.items).toHaveLength(20);
    const cursor = encodeURIComponent(first.nextCursor ?? '');
    const second = feedPageSchema.parse(
      (await call('GET', `/v1/profiles/${author}/looks?cursor=${cursor}`)).json(),
    );
    expect(second.nextCursor).toBeNull();
    expect([...first.items, ...second.items].map((c) => c.id)).toEqual(ids);
    expect(first.items.map((c) => c.id)).not.toContain(hidden);
  });
});

describe('following someone', () => {
  it('fills the Following feed with their looks, and unfollowing empties it', async () => {
    const author = await createAuthor(ctx.db, 'page.poster');
    const looks = await createLooks(ctx.db, [
      { authorId: author, hoursAgo: 1 },
      { authorId: author, hoursAgo: 2 },
    ]);
    const me = await viewer();
    const following = async () =>
      feedPageSchema.parse((await call('GET', '/v1/feed/following', me.token)).json()).items;

    expect(await following()).toEqual([]);
    await call('PUT', `/v1/follows/${author}`, me.token);
    expect((await following()).map((c) => c.id)).toEqual(looks);
    expect((await page(author, me.token)).counts.followers).toBe(1);
    expect((await page(me.profileId)).counts.following).toBe(1);

    await call('DELETE', `/v1/follows/${author}`, me.token);
    expect(await following()).toEqual([]);
  });
});
