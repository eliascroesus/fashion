import { and, eq, follows, lookMedia, media, sql } from '@outfitly/db';
import { IDEMPOTENT_REPLAY_HEADER, lookDetailSchema, meSchema } from '@outfitly/shared';
import type { FastifyInstance } from 'fastify';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createAuthor, createLogin, createLook } from './feed-fixtures.ts';
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
