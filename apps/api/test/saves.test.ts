import { and, boardItems, boards, eq, isNull, saves, sql, swipes } from '@outfitly/db';
import {
  boardListSchema,
  boardSchema,
  FEED_PAGE_SIZE,
  type FeedPage,
  feedPageSchema,
  IDEMPOTENT_REPLAY_HEADER,
  MAX_BOARDS_PER_PROFILE,
  meSchema,
  OCCASIONS,
  SEASONS,
} from '@outfitly/shared';
import type { FastifyInstance } from 'fastify';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  createAuthor,
  createLogin,
  createLook,
  createLooks,
  type LookSpec,
} from './feed-fixtures.ts';
import { buildTestApp, createTestContext, type TestContext } from './helpers.ts';

let ctx: TestContext;
let app: FastifyInstance;
let author: string;

beforeAll(async () => {
  ctx = await createTestContext();
  app = await buildTestApp(ctx);
  await app.ready();
  author = await createAuthor(ctx.db, 'saves.author');
});

afterAll(async () => {
  await app.close();
  await ctx.close();
});

type Method = 'GET' | 'PUT' | 'POST' | 'PATCH' | 'DELETE';

function call(
  method: Method,
  url: string,
  token?: string,
  payload?: object,
  key: string = crypto.randomUUID(),
) {
  return app.inject({
    method,
    url,
    headers: {
      ...(token ? { authorization: `Bearer ${token}` } : {}),
      ...(method === 'GET' ? {} : { 'idempotency-key': key }),
    },
    ...(payload ? { payload } : method === 'PUT' || method === 'POST' ? { payload: {} } : {}),
  });
}

async function viewer(): Promise<{ token: string; profileId: string }> {
  const { token } = await createLogin(ctx.db);
  const res = await call('POST', '/v1/session', token, {});
  const me = meSchema.parse(res.json());
  if (!me.activeProfileId) throw new Error('no active profile');
  return { token, profileId: me.activeProfileId };
}

async function getPage(url: string, token: string, cursor?: string | null): Promise<FeedPage> {
  const query = cursor
    ? `${url.includes('?') ? '&' : '?'}cursor=${encodeURIComponent(cursor)}`
    : '';
  const res = await call('GET', `${url}${query}`, token);
  expect(res.statusCode, res.body).toBe(200);
  return feedPageSchema.parse(res.json());
}

async function allIds(url: string, token: string): Promise<string[]> {
  const pages = [await getPage(url, token)];
  while (pages.at(-1)?.nextCursor) {
    pages.push(await getPage(url, token, pages.at(-1)?.nextCursor));
    if (pages.length > 20) throw new Error('list never ends');
  }
  return pages.flatMap((p) => p.items.map((c) => c.id));
}

const save = (lookId: string, token: string, key?: string) =>
  call('PUT', `/v1/saves/${lookId}`, token, {}, key);
const unsave = (lookId: string, token: string) => call('DELETE', `/v1/saves/${lookId}`, token);

async function activeSaveRows(profileId: string, lookId: string) {
  return ctx.db
    .select()
    .from(saves)
    .where(and(eq(saves.profileId, profileId), eq(saves.lookId, lookId)));
}

async function newBoard(token: string, name = 'Summer'): Promise<string> {
  const res = await call('POST', '/v1/boards', token, { name });
  expect(res.statusCode, res.body).toBe(201);
  return boardSchema.parse(res.json()).id;
}

async function boardList(token: string, lookId?: string) {
  const res = await call('GET', `/v1/boards${lookId ? `?lookId=${lookId}` : ''}`, token);
  expect(res.statusCode, res.body).toBe(200);
  return boardListSchema.parse(res.json()).items;
}

describe('saving a look', () => {
  it('saves once however often it is sent, and unsaves', async () => {
    const me = await viewer();
    const look = await createLook(ctx.db, { authorId: author });

    const first = await save(look, me.token);
    expect(first.statusCode, first.body).toBe(200);
    expect(first.json()).toEqual({ lookId: look, saved: true });
    expect((await save(look, me.token)).statusCode).toBe(200);
    expect(await activeSaveRows(me.profileId, look)).toHaveLength(1);
    expect(await allIds('/v1/saves', me.token)).toEqual([look]);

    const undone = await unsave(look, me.token);
    expect(undone.statusCode).toBe(200);
    expect(undone.json()).toEqual({ lookId: look, saved: false });
    expect((await unsave(look, me.token)).statusCode).toBe(200);
    expect(await allIds('/v1/saves', me.token)).toEqual([]);
    const [row] = await activeSaveRows(me.profileId, look);
    expect(row?.deletedAt).not.toBeNull();
  });

  it('keeps one row when the same save arrives twice at once (a double tap)', async () => {
    const me = await viewer();
    const look = await createLook(ctx.db, { authorId: author });
    const results = await Promise.all([save(look, me.token), save(look, me.token)]);
    expect(results.map((r) => r.statusCode)).toEqual([200, 200]);
    expect(await activeSaveRows(me.profileId, look)).toHaveLength(1);
  });

  it('replays a retry with the same Idempotency-Key', async () => {
    const me = await viewer();
    const look = await createLook(ctx.db, { authorId: author });
    const key = crypto.randomUUID();
    expect((await save(look, me.token, key)).statusCode).toBe(200);
    const retry = await save(look, me.token, key);
    expect(retry.statusCode).toBe(200);
    expect(retry.headers[IDEMPOTENT_REPLAY_HEADER]).toBe('true');
  });

  it('puts a look saved again at the top of the list (an existing save stays where it is)', async () => {
    const me = await viewer();
    const [a, b] = await createLooks(ctx.db, [{ authorId: author }, { authorId: author }]);
    if (!a || !b) throw new Error('no looks');
    await save(a, me.token);
    await save(b, me.token);
    expect(await allIds('/v1/saves', me.token)).toEqual([b, a]);
    await save(a, me.token); // already saved: nothing moves
    expect(await allIds('/v1/saves', me.token)).toEqual([b, a]);
    await unsave(a, me.token);
    await save(a, me.token);
    expect(await allIds('/v1/saves', me.token)).toEqual([a, b]);
  });

  it("refuses looks that can't be shown, and needs a login", async () => {
    const me = await viewer();
    const hidden = await createLook(ctx.db, { authorId: author, status: 'hidden' });
    const draft = await createLook(ctx.db, { authorId: author, status: 'draft' });
    const unready = await createLook(ctx.db, { authorId: author, cover: 'processing' });
    for (const id of [hidden, draft, unready, crypto.randomUUID()]) {
      expect((await save(id, me.token)).statusCode).toBe(404);
    }
    expect((await save('not-a-uuid', me.token)).statusCode).toBe(400);
    const look = await createLook(ctx.db, { authorId: author });
    expect((await call('PUT', `/v1/saves/${look}`, undefined, {})).statusCode).toBe(401);
    expect((await call('GET', '/v1/saves')).statusCode).toBe(401);
  });

  it('lists saves newest first, 20 a page, without repeats, leaving out looks hidden since', async () => {
    const me = await viewer();
    const looks = await createLooks(
      ctx.db,
      Array.from({ length: 45 }, () => ({ authorId: author })),
    );
    for (const id of looks) await save(id, me.token);
    const firstPage = await getPage('/v1/saves', me.token);
    expect(firstPage.items).toHaveLength(FEED_PAGE_SIZE);
    expect(firstPage.items.every((c) => c.saved)).toBe(true);

    const hiddenLater = looks[10] ?? '';
    await ctx.db.execute(sql`UPDATE looks SET status = 'hidden' WHERE id = ${hiddenLater}`);
    const all = await allIds('/v1/saves', me.token);
    expect(all).toEqual([...looks].reverse().filter((id) => id !== hiddenLater));
    expect(new Set(all).size).toBe(all.length);
  });

  it("keeps each profile's saves to itself", async () => {
    const [me, other] = [await viewer(), await viewer()];
    const look = await createLook(ctx.db, { authorId: author });
    await save(look, me.token);
    expect(await allIds('/v1/saves', other.token)).toEqual([]);
  });

  it('marks saved looks on feed cards for the viewer only', async () => {
    const me = await viewer();
    const look = await createLook(ctx.db, { authorId: author, popularity: 50 });
    await save(look, me.token);
    const mine = await getPage('/v1/feed/for-you', me.token);
    expect(mine.items.find((c) => c.id === look)?.saved).toBe(true);
    expect(mine.items.filter((c) => c.id !== look).every((c) => !c.saved)).toBe(true);
    const loggedOut = feedPageSchema.parse((await call('GET', '/v1/feed/for-you')).json());
    expect(loggedOut.items.every((c) => !c.saved)).toBe(true);
  });
});

describe('boards', () => {
  it('creates boards with tidy names and refuses bad ones', async () => {
    const me = await viewer();
    const res = await call('POST', '/v1/boards', me.token, { name: '  Summer   evenings ' });
    expect(res.statusCode, res.body).toBe(201);
    expect(boardSchema.parse(res.json())).toMatchObject({
      name: 'Summer evenings',
      lookCount: 0,
      covers: [],
    });
    for (const name of ['', '   ', 'x'.repeat(51), 'two\u0000words']) {
      expect((await call('POST', '/v1/boards', me.token, { name })).statusCode).toBe(400);
    }
    expect((await call('POST', '/v1/boards', me.token, { name: 'x'.repeat(50) })).statusCode).toBe(
      201,
    );
  });

  it('puts a look on several boards, which saves it; removing it from a board keeps it saved', async () => {
    const me = await viewer();
    const look = await createLook(ctx.db, { authorId: author });
    const [summer, work] = [await newBoard(me.token, 'Summer'), await newBoard(me.token, 'Work')];

    for (const board of [summer, work]) {
      const res = await call('PUT', `/v1/boards/${board}/looks/${look}`, me.token);
      expect(res.statusCode, res.body).toBe(200);
      expect(res.json()).toEqual({ boardId: board, lookId: look, inBoard: true });
    }
    expect(await allIds('/v1/saves', me.token)).toEqual([look]);
    expect(await allIds(`/v1/boards/${summer}/looks`, me.token)).toEqual([look]);
    expect(await allIds(`/v1/boards/${work}/looks`, me.token)).toEqual([look]);
    const withLook = await boardList(me.token, look);
    expect(withLook.map((b) => [b.name, b.hasLook, b.lookCount])).toEqual([
      ['Work', true, 1],
      ['Summer', true, 1],
    ]);

    const removed = await call('DELETE', `/v1/boards/${summer}/looks/${look}`, me.token);
    expect(removed.json()).toEqual({ boardId: summer, lookId: look, inBoard: false });
    expect(await allIds(`/v1/boards/${summer}/looks`, me.token)).toEqual([]);
    expect(await allIds('/v1/saves', me.token)).toEqual([look]);
    expect((await boardList(me.token, look)).find((b) => b.id === summer)?.hasLook).toBe(false);
  });

  it('takes an unsaved look off every board', async () => {
    const me = await viewer();
    const look = await createLook(ctx.db, { authorId: author });
    const board = await newBoard(me.token);
    await call('PUT', `/v1/boards/${board}/looks/${look}`, me.token);
    await unsave(look, me.token);
    expect(await allIds(`/v1/boards/${board}/looks`, me.token)).toEqual([]);
    const items = await ctx.db
      .select()
      .from(boardItems)
      .where(and(eq(boardItems.boardId, board), isNull(boardItems.deletedAt)));
    expect(items).toHaveLength(0);
  });

  it('lists boards most recently changed first, with counts and the newest 3 covers', async () => {
    const me = await viewer();
    const looks = await createLooks(
      ctx.db,
      Array.from({ length: 5 }, () => ({ authorId: author })),
    );
    const older = await newBoard(me.token, 'Older');
    const newer = await newBoard(me.token, 'Newer');
    expect((await boardList(me.token)).map((b) => b.id)).toEqual([newer, older]);
    for (const id of looks) await call('PUT', `/v1/boards/${older}/looks/${id}`, me.token);
    const hidden = looks[4] ?? '';
    await ctx.db.execute(sql`UPDATE looks SET status = 'hidden' WHERE id = ${hidden}`);

    const [first, second] = await boardList(me.token);
    expect(first?.id).toBe(older); // a look was added: it moved up
    expect(first?.lookCount).toBe(4); // the hidden one isn't counted
    expect(first?.covers).toHaveLength(3);
    expect(first?.covers[0]?.urls[300]).toMatch(/^https:\/\/img\.test\/m\/.+\/300\.webp$/);
    expect(first?.hasLook).toBeUndefined();
    expect(second).toMatchObject({ id: newer, lookCount: 0, covers: [] });
    // Newest first, without the hidden look.
    expect(await allIds(`/v1/boards/${older}/looks`, me.token)).toEqual(
      looks.slice(0, 4).reverse(),
    );
  });

  it('pages through a board 20 at a time without repeats', async () => {
    const me = await viewer();
    const looks = await createLooks(
      ctx.db,
      Array.from({ length: 25 }, () => ({ authorId: author })),
    );
    const board = await newBoard(me.token);
    for (const id of looks) await call('PUT', `/v1/boards/${board}/looks/${id}`, me.token);
    const first = await getPage(`/v1/boards/${board}/looks`, me.token);
    expect(first.items).toHaveLength(FEED_PAGE_SIZE);
    const all = await allIds(`/v1/boards/${board}/looks`, me.token);
    expect(all).toEqual([...looks].reverse());
  });

  it('renames and deletes; a deleted board is gone but its looks stay saved', async () => {
    const me = await viewer();
    const look = await createLook(ctx.db, { authorId: author });
    const board = await newBoard(me.token, 'Old name');
    await call('PUT', `/v1/boards/${board}/looks/${look}`, me.token);

    const renamed = await call('PATCH', `/v1/boards/${board}`, me.token, { name: 'New name' });
    expect(renamed.statusCode, renamed.body).toBe(200);
    expect(boardSchema.parse(renamed.json())).toMatchObject({ name: 'New name', lookCount: 1 });

    const deleted = await call('DELETE', `/v1/boards/${board}`, me.token);
    expect(deleted.statusCode).toBe(200);
    expect(deleted.json()).toEqual({ id: board, deleted: true });
    expect(await boardList(me.token)).toEqual([]);
    expect(await allIds('/v1/saves', me.token)).toEqual([look]);
    expect((await call('DELETE', `/v1/boards/${board}`, me.token)).statusCode).toBe(404);
    expect((await call('PUT', `/v1/boards/${board}/looks/${look}`, me.token)).statusCode).toBe(404);
    expect((await call('GET', `/v1/boards/${board}/looks`, me.token)).statusCode).toBe(404);
  });

  it("can't see or change someone else's board", async () => {
    const [me, other] = [await viewer(), await viewer()];
    const look = await createLook(ctx.db, { authorId: author });
    const board = await newBoard(me.token);
    const attempts = [
      call('GET', `/v1/boards/${board}/looks`, other.token),
      call('PUT', `/v1/boards/${board}/looks/${look}`, other.token),
      call('DELETE', `/v1/boards/${board}/looks/${look}`, other.token),
      call('PATCH', `/v1/boards/${board}`, other.token, { name: 'Mine now' }),
      call('DELETE', `/v1/boards/${board}`, other.token),
    ];
    for (const res of await Promise.all(attempts)) expect(res.statusCode).toBe(404);
    expect(await boardList(other.token)).toEqual([]);
    const [mine] = await boardList(me.token);
    expect(mine?.name).toBe('Summer');
  });

  it(`stops at ${String(MAX_BOARDS_PER_PROFILE)} boards per profile`, async () => {
    const me = await viewer();
    await ctx.db.insert(boards).values(
      Array.from({ length: MAX_BOARDS_PER_PROFILE - 1 }, (_, i) => ({
        profileId: me.profileId,
        name: `Board ${String(i)}`,
      })),
    );
    const results = await Promise.all([
      call('POST', '/v1/boards', me.token, { name: 'Last one' }),
      call('POST', '/v1/boards', me.token, { name: 'One too many' }),
    ]);
    expect(results.map((r) => r.statusCode).sort()).toEqual([201, 409]);
    expect(await boardList(me.token)).toHaveLength(MAX_BOARDS_PER_PROFILE);
  });

  it('replays board changes and "see less" retried with the same Idempotency-Key', async () => {
    const me = await viewer();
    const look = await createLook(ctx.db, { authorId: author });
    const board = await newBoard(me.token);
    const requests = [
      ['PUT', `/v1/boards/${board}/looks/${look}`, undefined],
      ['DELETE', `/v1/boards/${board}/looks/${look}`, undefined],
      ['PUT', `/v1/swipes/${look}`, { kind: 'see_less' }],
    ] as const;
    for (const [method, url, payload] of requests) {
      const key = crypto.randomUUID();
      const first = await call(method, url, me.token, payload, key);
      const retry = await call(method, url, me.token, payload, key);
      expect(first.statusCode, first.body).toBe(200);
      expect(retry.statusCode).toBe(200);
      expect(retry.headers[IDEMPOTENT_REPLAY_HEADER]).toBe('true');
      expect(retry.body).toBe(first.body);
    }
  });

  it('refuses looks that cannot be shown', async () => {
    const me = await viewer();
    const board = await newBoard(me.token);
    const hidden = await createLook(ctx.db, { authorId: author, status: 'hidden' });
    expect((await call('PUT', `/v1/boards/${board}/looks/${hidden}`, me.token)).statusCode).toBe(
      404,
    );
  });
});

describe('see less like this', () => {
  it('leaves the look out of new For You lists and moves similar looks to the back', async () => {
    // A catalogue of its own: 8 popular party/winter looks, and 20 less popular ones in other styles.
    const owners = [
      await createAuthor(ctx.db, 'seeless.a'),
      await createAuthor(ctx.db, 'seeless.b'),
      await createAuthor(ctx.db, 'seeless.c'),
      await createAuthor(ctx.db, 'seeless.d'),
    ];
    const others = OCCASIONS.flatMap((o) => SEASONS.map((s) => [o, s] as const))
      .filter(([o, s]) => !(o === 'party' && s === 'winter'))
      .slice(0, 20);
    const specs: LookSpec[] = [
      ...Array.from({ length: 8 }, (_, i) => ({
        authorId: owners[i % 4] ?? '',
        occasions: ['party' as const],
        seasons: ['winter' as const],
        popularity: 90 + i,
      })),
      ...others.map(([o, s], i) => ({
        authorId: owners[i % 4] ?? '',
        occasions: [o],
        seasons: [s],
        popularity: 10 + i,
      })),
    ];
    const ids = await createLooks(ctx.db, specs);
    const party = new Set(ids.slice(0, 8));
    const me = await viewer();
    const disliked = ids[0] ?? '';

    const before = await getPage('/v1/feed/for-you', me.token);
    expect(before.items.slice(0, 3).some((c) => party.has(c.id))).toBe(true);

    const res = await call('PUT', `/v1/swipes/${disliked}`, me.token, { kind: 'see_less' });
    expect(res.statusCode, res.body).toBe(200);
    expect(
      (await call('PUT', `/v1/swipes/${disliked}`, me.token, { kind: 'see_less' })).statusCode,
    ).toBe(200);
    expect(
      await ctx.db.select().from(swipes).where(eq(swipes.profileId, me.profileId)),
    ).toHaveLength(1);
    expect(
      (await call('PUT', `/v1/swipes/${disliked}`, me.token, { kind: 'skip' })).statusCode,
    ).toBe(400);

    const after = await allIds('/v1/feed/for-you', me.token);
    expect(after).not.toContain(disliked);
    // Every other style fills the first places; the similar looks come at the end.
    const ours = after.filter((id) => ids.includes(id));
    expect(ours.slice(0, 15).some((id) => party.has(id))).toBe(false);
  });
});
