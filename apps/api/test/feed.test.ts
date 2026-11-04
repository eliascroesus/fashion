import {
  and,
  desc,
  eq,
  feedSnapshots,
  follows,
  inArray,
  isNull,
  looks,
  profiles,
  seen,
  sql,
  swipes,
  tasteProfiles,
} from '@outfitly/db';
import {
  FEED_PAGE_SIZE,
  type FeedPage,
  feedPageSchema,
  meSchema,
  OCCASIONS,
  SEASONS,
  type Style,
  STYLES,
} from '@outfitly/shared';
import type { FastifyInstance } from 'fastify';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { FEED_RULES } from '../src/feed/arrange.ts';
import { encodeCursor } from '../src/feed/cards.ts';
import { recomputePopularity } from '../src/feed/popularity.ts';
import {
  candidatesFor,
  createAuthor,
  createLogin,
  createLook,
  createLooks,
  diversityViolations,
  type LookSpec,
  seeded,
} from './feed-fixtures.ts';
import { buildTestApp, createTestContext, type TestContext } from './helpers.ts';

let ctx: TestContext;
let app: FastifyInstance;
const authors: string[] = [];

/** More looks than one For You list holds, so every list is full and never runs dry. */
const CATALOGUE = 480;
const FRESH = 40;
/** Left out of the catalogue: only the taste pool can bring a look in this style to page 1. */
const RARE_STYLE: Style = 'colorful';

beforeAll(async () => {
  ctx = await createTestContext();
  app = await buildTestApp(ctx);
  await app.ready();

  for (let a = 0; a < 8; a++) authors.push(await createAuthor(ctx.db, `author.${String(a)}`));
  const random = seeded(7);
  // Styles from their own random stream, so they don't line up with authors or tag sets
  // (otherwise the diversity rules, not the taste pool, would decide what page 1 shows).
  const styleRandom = seeded(11);
  const styles = STYLES.filter((style) => style !== RARE_STYLE);
  // 7 occasions × 4 seasons = 28 different tag sets.
  const occasions = OCCASIONS.filter((o) => o !== 'festival');
  const specs: LookSpec[] = Array.from({ length: CATALOGUE }, (_, i) => ({
    authorId: authors[i % authors.length] ?? '',
    occasions: [occasions[i % occasions.length] ?? 'everyday'],
    seasons: [SEASONS[Math.floor(i / occasions.length) % SEASONS.length] ?? 'autumn'],
    styles: [styles[Math.floor(styleRandom() * styles.length)] ?? 'minimal'],
    // The first FRESH are new but not popular yet: only the fresh pool lifts them.
    hoursAgo: i < FRESH ? 1 + i : 80 + i,
    popularity: i < FRESH ? 0.0001 : 0.02 + 0.2 * random(),
  }));
  await createLooks(ctx.db, specs);
});

afterAll(async () => {
  await app.close();
  await ctx.close();
});

async function get(url: string, token?: string) {
  return app.inject({
    method: 'GET',
    url,
    headers: token ? { authorization: `Bearer ${token}` } : {},
  });
}

async function page(feed: string, cursor?: string | null, token?: string): Promise<FeedPage> {
  const query = cursor ? `?cursor=${encodeURIComponent(cursor)}` : '';
  const res = await get(`/v1/feed/${feed}${query}`, token);
  expect(res.statusCode, res.body).toBe(200);
  return feedPageSchema.parse(res.json());
}

/** Every page until the end; `between` runs after the first page. */
async function allPages(
  feed: string,
  token?: string,
  between?: () => Promise<void>,
): Promise<FeedPage[]> {
  const pages = [await page(feed, undefined, token)];
  if (between) await between();
  while (pages.at(-1)?.nextCursor) {
    pages.push(await page(feed, pages.at(-1)?.nextCursor, token));
    if (pages.length > 50) throw new Error('feed never ends');
  }
  return pages;
}

const ids = (pages: readonly FeedPage[]) => pages.flatMap((p) => p.items.map((i) => i.id));

function snapshotIdOf(cursor: string | null): string {
  if (!cursor) throw new Error('no cursor');
  return (JSON.parse(Buffer.from(cursor, 'base64url').toString()) as { s: string }).s;
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

describe('GET /v1/feed/for-you', () => {
  it('works logged out: 20 cards per page, each sized up front', async () => {
    const first = await page('for-you');
    expect(first.items).toHaveLength(FEED_PAGE_SIZE);
    expect(first.nextCursor).toEqual(expect.any(String));
    const card = first.items[0];
    expect(card?.photo).toMatchObject({
      width: 1080,
      height: 1440,
      thumbhash: expect.any(String) as string,
      dominantColor: '#a08870',
    });
    expect(card?.photo.urls[600]).toMatch(/^https:\/\/img\.test\/m\/[0-9a-f-]{36}\/600\.webp$/);
    expect(card?.itemCount).toBe(0);
  });

  it('never repeats a look across pages, and ends after one full list', async () => {
    const pages = await allPages('for-you');
    const all = ids(pages);
    expect(all).toHaveLength(FEED_RULES.snapshotSize);
    expect(new Set(all).size).toBe(all.length);
    expect(pages.at(-1)?.nextCursor).toBeNull();
    expect(pages.slice(0, -1).every((p) => p.items.length === FEED_PAGE_SIZE)).toBe(true);
  });

  it('keeps the diversity rules on every page and across page breaks', async () => {
    const all = ids(await allPages('for-you'));
    expect(diversityViolations(await candidatesFor(ctx.db, all))).toEqual([]);
  });

  it('mixes in new looks on the first page even before they are popular', async () => {
    const first = await page('for-you');
    const fresh = await ctx.db
      .select({ id: looks.id })
      .from(looks)
      .where(sql`${looks.publishedAt} > now() - interval '72 hours'`);
    const freshIds = new Set(fresh.map((r) => r.id));
    expect(first.items.filter((i) => freshIds.has(i.id)).length).toBeGreaterThanOrEqual(5);
  });

  it('never repeats a look even when popularity is recomputed mid-scroll', async () => {
    const all = ids(
      await allPages('for-you', undefined, async () => {
        await recomputePopularity(ctx.db);
      }),
    );
    expect(all).toHaveLength(FEED_RULES.snapshotSize);
    expect(new Set(all).size).toBe(all.length);
  });

  it('lets logged-out visitors share a few recent lists, so visits add no rows', async () => {
    const sharedLists = async () =>
      ctx.db.$count(
        feedSnapshots,
        and(
          isNull(feedSnapshots.profileId),
          isNull(feedSnapshots.tasteKey),
          sql`${feedSnapshots.createdAt} > now() - interval '15 minutes'`,
        ),
      );
    const used = new Set<string>();
    for (let i = 0; i < 30; i++) used.add(snapshotIdOf((await page('for-you')).nextCursor));
    expect(await sharedLists()).toBe(FEED_RULES.sharedLists);
    // Refreshing still lands on different lists.
    expect(used.size).toBeGreaterThan(1);
  });

  it('gives a logged-in refresh a slightly different order, keeping only the newest lists', async () => {
    const { token, profileId } = await viewer();
    const firstPages = [];
    for (let i = 0; i < 8; i++) firstPages.push(ids([await page('for-you', undefined, token)]));
    expect(firstPages[1]).not.toEqual(firstPages[0]);
    expect(await ctx.db.$count(feedSnapshots, eq(feedSnapshots.profileId, profileId))).toBe(
      FEED_RULES.listsPerProfile,
    );
  });

  it('gives a login without a profile yet the logged-out feed', async () => {
    const { token } = await createLogin(ctx.db);
    expect((await page('for-you', undefined, token)).items).toHaveLength(FEED_PAGE_SIZE);
  });

  it('skips a look hidden between pages and still fills the page', async () => {
    const first = await page('for-you');
    const [snapshot] = await ctx.db
      .select({ lookIds: feedSnapshots.lookIds })
      .from(feedSnapshots)
      .where(eq(feedSnapshots.id, snapshotIdOf(first.nextCursor)));
    const list = snapshot?.lookIds ?? [];
    const hidden = list.slice(20, 25);
    await ctx.db.update(looks).set({ status: 'hidden' }).where(inArray(looks.id, hidden));
    try {
      const second = await page('for-you', first.nextCursor);
      expect(second.items.map((i) => i.id)).toEqual(list.slice(25, 45));
    } finally {
      await ctx.db.update(looks).set({ status: 'published' }).where(inArray(looks.id, hidden));
    }
  });

  it('refuses a broken cursor', async () => {
    const wrongShape = encodeCursor({ t: '2026-11-03T10:00:00.000000Z', id: crypto.randomUUID() });
    const huge = encodeCursor({ s: crypto.randomUUID(), i: 2147483647 });
    for (const cursor of ['not-a-cursor!!', encodeCursor({ s: 'nope', i: 1 }), wrongShape, huge]) {
      const res = await get(`/v1/feed/for-you?cursor=${encodeURIComponent(cursor)}`);
      expect(res.statusCode).toBe(400);
      expect(res.json()).toMatchObject({ error: { code: 'validation_failed' } });
    }
  });

  it('starts a new list when the old one is gone', async () => {
    const gone = encodeCursor({ s: crypto.randomUUID(), i: 20 });
    const res = await page('for-you', gone);
    expect(res.items).toHaveLength(FEED_PAGE_SIZE);
    expect(snapshotIdOf(res.nextCursor)).not.toBe(snapshotIdOf(gone));
  });

  it("starts a new list for another profile's cursor", async () => {
    const anna = await viewer();
    const ben = await viewer();
    const annas = await page('for-you', undefined, anna.token);
    const bens = await page('for-you', annas.nextCursor, ben.token);
    expect(snapshotIdOf(bens.nextCursor)).not.toBe(snapshotIdOf(annas.nextCursor));
    const [row] = await ctx.db
      .select({ profileId: feedSnapshots.profileId })
      .from(feedSnapshots)
      .where(eq(feedSnapshots.id, snapshotIdOf(annas.nextCursor)));
    expect(row?.profileId).toBe(anna.profileId);
  });

  it('continues a logged-out list after the first login (guest session at first save)', async () => {
    const loggedOut = await page('for-you');
    const { token } = await viewer();
    const next = await page('for-you', loggedOut.nextCursor, token);
    expect(snapshotIdOf(next.nextCursor)).toBe(snapshotIdOf(loggedOut.nextCursor));
    const seenIds = new Set(loggedOut.items.map((i) => i.id));
    expect(next.items.some((i) => seenIds.has(i.id))).toBe(false);
  });

  it('rejects an invalid login even though the feed is public', async () => {
    const res = await get('/v1/feed/for-you', 'not-a-token');
    expect(res.statusCode).toBe(401);
  });
});

describe('GET /v1/feed/for-you, personalised', () => {
  let me: { token: string; profileId: string };
  const special: Record<string, string> = {};

  beforeAll(async () => {
    me = await viewer();
    // Old and unpopular: only their own pool can bring these to the first page.
    const followed = await createAuthor(ctx.db, 'followed.one');
    special['followed'] = await createLook(ctx.db, { authorId: followed, popularity: 0.0001 });
    await ctx.db
      .insert(follows)
      .values({ followerProfileId: me.profileId, followedProfileId: followed });
    const tasteAuthor = await createAuthor(ctx.db, 'taste.one');
    special['taste'] = await createLook(ctx.db, {
      authorId: tasteAuthor,
      styles: [RARE_STYLE],
      popularity: 0.0001,
    });
    await ctx.db.insert(tasteProfiles).values({ profileId: me.profileId, styles: [RARE_STYLE] });

    // Very popular, so they'd lead the feed if they were allowed in.
    const top = { authorId: authors[0] ?? '', popularity: 1 };
    special['seenRecently'] = await createLook(ctx.db, top);
    special['seenLongAgo'] = await createLook(ctx.db, { ...top, authorId: authors[1] ?? '' });
    await ctx.db.insert(seen).values([
      {
        profileId: me.profileId,
        lookId: special['seenRecently'],
        lastSeenAt: sql`now() - interval '2 hours'`,
      },
      {
        profileId: me.profileId,
        lookId: special['seenLongAgo'],
        lastSeenAt: sql`now() - interval '8 days'`,
      },
    ]);
    special['own'] = await createLook(ctx.db, { ...top, authorId: me.profileId });
    special['future'] = await createLook(ctx.db, { ...top, hoursAgo: -5 });
    special['draft'] = await createLook(ctx.db, { ...top, status: 'draft' });
    special['hidden'] = await createLook(ctx.db, { ...top, status: 'hidden' });
    special['notReady'] = await createLook(ctx.db, { ...top, cover: 'processing' });
    const gone = await createAuthor(ctx.db, 'deleted.author');
    special['deletedAuthor'] = await createLook(ctx.db, { ...top, authorId: gone });
    await ctx.db
      .update(profiles)
      .set({ deletedAt: sql`now()` })
      .where(eq(profiles.id, gone));
  });

  it('puts looks from people you follow and matching your taste on the first page', async () => {
    const first = (await page('for-you', undefined, me.token)).items.map((i) => i.id);
    expect(first).toContain(special['followed']);
    expect(first).toContain(special['taste']);
  });

  it('leaves out looks seen in the last 7 days, but not older ones', async () => {
    const all = ids(await allPages('for-you', me.token));
    expect(all).not.toContain(special['seenRecently']);
    expect(all).toContain(special['seenLongAgo']);
  });

  it('never shows your own looks, future, draft or hidden looks, deleted authors or unready photos', async () => {
    const mine = new Set(ids(await allPages('for-you', me.token)));
    // Someone else gets a fresh list (logged-out lists may predate these looks).
    const someoneElse = await viewer();
    const theirs = new Set(ids(await allPages('for-you', someoneElse.token)));
    for (const key of ['own', 'future', 'draft', 'hidden', 'notReady', 'deletedAuthor']) {
      expect(mine.has(special[key] ?? ''), key).toBe(false);
    }
    for (const key of ['future', 'draft', 'hidden', 'notReady', 'deletedAuthor']) {
      expect(theirs.has(special[key] ?? ''), key).toBe(false);
    }
    // Others do see your look.
    expect(theirs.has(special['own'] ?? '')).toBe(true);
  });

  it('keeps every rule and never repeats a look, logged in', async () => {
    const all = ids(await allPages('for-you', me.token));
    expect(new Set(all).size).toBe(all.length);
    expect(diversityViolations(await candidatesFor(ctx.db, all))).toEqual([]);
  });
});

describe('GET /v1/feed/for-you, taste picker styles', () => {
  /** How many of a page's looks are in `style`. */
  async function inStyle(feed: FeedPage, style: Style): Promise<number> {
    const rows = await ctx.db
      .select({ styleTags: looks.styleTags })
      .from(looks)
      .where(
        inArray(
          looks.id,
          feed.items.map((i) => i.id),
        ),
      );
    return rows.filter((r) => r.styleTags.includes(style)).length;
  }
  const firstPageWith = (styles: string, token?: string) =>
    page(`for-you?styles=${styles}` as 'for-you', undefined, token);
  const listsFor = (tasteKey: string) =>
    ctx.db.$count(
      feedSnapshots,
      and(isNull(feedSnapshots.profileId), eq(feedSnapshots.tasteKey, tasteKey)),
    );

  it('makes most of page 1 streetwear for a logged-out phone that picked Streetwear', async () => {
    // The first two requests each rank a new shared list for this choice.
    for (let i = 0; i < FEED_RULES.sharedListsPerTaste; i++) {
      const first = await firstPageWith('streetwear');
      expect(first.items).toHaveLength(FEED_PAGE_SIZE);
      expect(await inStyle(first, 'streetwear')).toBeGreaterThanOrEqual(11);
    }
  });

  it('does the same for profiles whose stored taste is Streetwear, every time', async () => {
    for (let i = 0; i < 5; i++) {
      const { token, profileId } = await viewer();
      await ctx.db.insert(tasteProfiles).values({ profileId, styles: ['streetwear'] });
      const first = await page('for-you', undefined, token);
      expect(await inStyle(first, 'streetwear')).toBeGreaterThanOrEqual(11);
      expect(diversityViolations(await candidatesFor(ctx.db, ids([first])))).toEqual([]);
    }
  });

  it("uses the phone's styles when the stored taste has none (brands only)", async () => {
    const { token, profileId } = await viewer();
    await ctx.db.insert(tasteProfiles).values({ profileId, styles: [], brands: ['cos'] });
    expect(
      await inStyle(await firstPageWith('streetwear', token), 'streetwear'),
    ).toBeGreaterThanOrEqual(11);
  });

  it("uses the phone's styles until the profile has a taste, then the stored one", async () => {
    const { token, profileId } = await viewer();
    expect(
      await inStyle(await firstPageWith('streetwear', token), 'streetwear'),
    ).toBeGreaterThanOrEqual(11);
    await ctx.db.insert(tasteProfiles).values({ profileId, styles: ['edgy'] });
    const first = await firstPageWith('streetwear', token);
    expect(await inStyle(first, 'edgy')).toBeGreaterThanOrEqual(11);
    expect(await inStyle(first, 'streetwear')).toBeLessThan(11);
  });

  it('keeps a few shared lists per style choice, apart from the plain ones', async () => {
    const plainBefore = await ctx.db.$count(
      feedSnapshots,
      and(isNull(feedSnapshots.profileId), isNull(feedSnapshots.tasteKey)),
    );
    for (let i = 0; i < 6; i++) await firstPageWith('streetwear,minimal');
    // Order and repeats don't make another choice.
    await firstPageWith('minimal,streetwear,minimal');
    expect(await listsFor('minimal,streetwear')).toBe(FEED_RULES.sharedListsPerTaste);
    expect(
      await ctx.db.$count(
        feedSnapshots,
        and(isNull(feedSnapshots.profileId), isNull(feedSnapshots.tasteKey)),
      ),
    ).toBe(plainBefore);
    // Unknown styles are dropped: this is the plain feed.
    const plain = await firstPageWith('goth');
    const [row] = await ctx.db
      .select({ tasteKey: feedSnapshots.tasteKey })
      .from(feedSnapshots)
      .where(eq(feedSnapshots.id, snapshotIdOf(plain.nextCursor)));
    expect(row?.tasteKey).toBeNull();
  });

  it("stops making new styled lists past the cap: reuses the choice's list from the day, else a plain one", async () => {
    const filler = Array.from({ length: FEED_RULES.styledListsPerWindow }, (_, i) => ({
      lookIds: [] as string[],
      tasteKey: `cap-test-${String(i)}`,
    }));
    await ctx.db.insert(feedSnapshots).values(filler);
    const [older] = await ctx.db
      .insert(feedSnapshots)
      .values({
        lookIds: (await page('for-you')).items.map((i) => i.id),
        tasteKey: 'sporty',
        createdAt: sql`now() - interval '3 hours'`,
      })
      .returning({ id: feedSnapshots.id });
    try {
      const reused = await firstPageWith('sporty');
      const [olderList] = await ctx.db
        .select({ lookIds: feedSnapshots.lookIds })
        .from(feedSnapshots)
        .where(eq(feedSnapshots.id, older?.id ?? ''));
      expect(reused.items.map((i) => i.id)).toEqual(olderList?.lookIds.slice(0, FEED_PAGE_SIZE));
      expect(await listsFor('sporty')).toBe(1);

      const fallback = await firstPageWith('edgy,romantic');
      expect(fallback.items).toHaveLength(FEED_PAGE_SIZE);
      expect(await listsFor('edgy,romantic')).toBe(0);
    } finally {
      await ctx.db
        .delete(feedSnapshots)
        .where(
          sql`${feedSnapshots.tasteKey} like 'cap-test-%' or ${feedSnapshots.tasteKey} = 'sporty'`,
        );
    }
  });
});

describe('GET /v1/feed/for-you, when few unseen looks are left', () => {
  it('tops the list up with looks seen longest ago, never ones seen in the last day', async () => {
    const { token, profileId } = await viewer();
    const all = await ctx.db
      .select({ id: looks.id })
      .from(looks)
      .where(sql`${looks.status} = 'published'`);
    const allIds = all.map((r) => r.id);
    // The catalogue's newest 40, in order: varied posters and tags, all showable.
    const catalogue = await ctx.db
      .select({ id: looks.id })
      .from(looks)
      .where(inArray(looks.authorProfileId, authors))
      .orderBy(desc(looks.publishedAt))
      .limit(40);
    const longAgo = new Set(catalogue.slice(0, 30).map((r) => r.id));
    const recent = new Set(catalogue.slice(30).map((r) => r.id));
    // Seen days ago too, but never to come back: hidden since, your own, and "see less".
    const hiddenSince = await createLook(ctx.db, { authorId: authors[2] ?? '', status: 'hidden' });
    const own = await createLook(ctx.db, { authorId: profileId });
    const lessLike = catalogue[0]?.id ?? '';
    await ctx.db.insert(swipes).values({ profileId, lookId: lessLike, kind: 'see_less' });
    allIds.push(hiddenSince, own);
    // Everything was seen within the week: nothing is unseen any more.
    await ctx.db.insert(seen).values(
      allIds.map((lookId) => ({
        profileId,
        lookId,
        lastSeenAt: longAgo.has(lookId)
          ? sql`now() - interval '6 days'`
          : recent.has(lookId)
            ? sql`now() - interval '2 hours'`
            : sql`now() - interval '3 days'`,
      })),
    );

    const pages = await allPages('for-you', token);
    const shown = ids(pages);
    expect(pages[0]?.items).toHaveLength(FEED_PAGE_SIZE);
    expect(shown.length).toBeGreaterThanOrEqual(FEED_RULES.snapshotSize);
    expect(shown.some((id) => recent.has(id))).toBe(false);
    for (const never of [hiddenSince, own, lessLike]) expect(shown).not.toContain(never);
    expect(new Set(shown).size).toBe(shown.length);
    // Seen longest ago comes first (the diversity rules may move a few).
    const firstPage = pages[0]?.items.map((i) => i.id) ?? [];
    expect(firstPage.filter((id) => longAgo.has(id)).length).toBeGreaterThanOrEqual(14);
    expect(diversityViolations(await candidatesFor(ctx.db, shown))).toEqual([]);
  });
});

describe('GET /v1/feed/following', () => {
  let me: { token: string; profileId: string };
  let busy: string;
  let notShown: string[] = [];

  beforeAll(async () => {
    me = await viewer();
    busy = await createAuthor(ctx.db, 'busy.poster');
    const posted = await createLooks(
      ctx.db,
      Array.from({ length: 25 }, () => ({ authorId: busy })),
    );
    // Many share a publish time, others differ only in microseconds (a JS Date can't tell them apart).
    await ctx.db
      .update(looks)
      .set({
        publishedAt: sql`'2026-10-01T10:00:00Z'::timestamptz + make_interval(secs => (abs(hashtext(${looks.id}::text)) % 3) * 0.000001)`,
      })
      .where(inArray(looks.id, posted));
    notShown = [
      await createLook(ctx.db, { authorId: busy, status: 'hidden' }),
      await createLook(ctx.db, { authorId: busy, cover: 'processing' }),
      await createLook(ctx.db, { authorId: busy, hoursAgo: -5 }),
    ];
    await ctx.db.insert(follows).values([
      { followerProfileId: me.profileId, followedProfileId: busy },
      { followerProfileId: me.profileId, followedProfileId: authors[2] ?? '' },
    ]);
  });

  it('needs a login', async () => {
    expect((await get('/v1/feed/following')).statusCode).toBe(401);
  });

  it('shows everything from people you follow, newest first, with nothing skipped or repeated', async () => {
    const all = ids(await allPages('following', me.token));
    const expected = await ctx.db
      .select({ id: looks.id })
      .from(looks)
      .where(
        and(
          inArray(looks.authorProfileId, [busy, authors[2] ?? '']),
          eq(looks.status, 'published'),
        ),
      )
      .orderBy(sql`${looks.publishedAt} DESC, ${looks.id} DESC`);
    // Hidden ones are already out of `expected`; unready and future ones must be left out too.
    expect(all).toEqual(expected.map((r) => r.id).filter((id) => !notShown.includes(id)));
    expect(all.some((id) => notShown.includes(id))).toBe(false);
    expect(all.length).toBeGreaterThan(2 * FEED_PAGE_SIZE);
  });

  it('is empty for someone who follows nobody', async () => {
    const someone = await viewer();
    expect(await page('following', undefined, someone.token)).toEqual({
      items: [],
      nextCursor: null,
    });
  });

  it('stops showing someone after you unfollow them', async () => {
    await ctx.db
      .update(follows)
      .set({ deletedAt: sql`now()` })
      .where(eq(follows.followerProfileId, me.profileId));
    expect((await page('following', undefined, me.token)).items).toEqual([]);
  });

  it('refuses a broken cursor, including impossible times', async () => {
    const id = crypto.randomUUID();
    const cursors = [
      encodeCursor({ s: crypto.randomUUID(), i: 20 }),
      encodeCursor({ t: '2026-13-45T99:99:99.000000Z', id }),
      encodeCursor({ t: '2026-02-30T10:00:00.000000Z', id }),
      encodeCursor({ t: '0000-01-01T00:00:00.000000Z', id }),
    ];
    for (const cursor of cursors) {
      const res = await get(`/v1/feed/following?cursor=${cursor}`, me.token);
      expect(res.statusCode, cursor).toBe(400);
      expect(res.json()).toMatchObject({ error: { code: 'validation_failed' } });
    }
  });
});

describe('an empty catalogue', () => {
  let empty: TestContext;
  let emptyApp: FastifyInstance;

  beforeAll(async () => {
    empty = await createTestContext();
    emptyApp = await buildTestApp(empty);
    await emptyApp.ready();
  });

  afterAll(async () => {
    await emptyApp.close();
    await empty.close();
  });

  it('answers with an empty page and saves no list', async () => {
    const res = await emptyApp.inject({ method: 'GET', url: '/v1/feed/for-you' });
    expect(res.json()).toEqual({ items: [], nextCursor: null });
    expect(await empty.db.$count(feedSnapshots)).toBe(0);
  });
});
