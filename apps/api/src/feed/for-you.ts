import {
  and,
  type Db,
  desc,
  eq,
  feedSnapshots,
  gt,
  isNotNull,
  isNull,
  notInArray,
  type SQL,
  sql,
  tasteProfiles,
} from '@outfitly/db';
import {
  FEED_PAGE_SIZE,
  type FeedCard,
  type FeedPage,
  knownStyles,
  type Style,
} from '@outfitly/shared';
import { z } from 'zod';
import {
  applyDiversity,
  type Candidate,
  demoteSimilar,
  FEED_RULES,
  interleave,
  jitter,
  type Pool,
  similarityKey,
} from './arrange.ts';
import { decodeCursor, encodeCursor, type FeedDeps, loadCards, showableLook } from './cards.ts';

/** Where the next page starts: a position in a saved For You list. */
const cursorSchema = z.object({
  s: z.uuid(),
  i: z.number().int().nonnegative().max(FEED_RULES.snapshotSize),
});

interface CandidateRow extends Record<string, unknown> {
  pool: Pool;
  id: string;
  author_profile_id: string;
  occasion_tags: string[];
  season_tags: string[];
  popularity_score: number;
}

type Scored = Candidate & { score: number };

/**
 * Looks in any of `styles` (as a look_style[]: a plain JS array would become a
 * list of parameters). No styles: plain `false`, so Postgres skips the pool
 * instead of reading every look to find none.
 */
function inStyles(look: SQL, styles: readonly Style[]): SQL {
  if (styles.length === 0) return sql`false`;
  const list = sql.join(
    styles.map((style) => sql`${style}`),
    sql`, `,
  );
  return sql`${look}.style_tags && ARRAY[${list}]::look_style[]`;
}

/**
 * Up to `poolLimit` candidates from each of the four pools, in one round trip.
 * Each pool walks its own index (see looks_feed_*_idx) and stops early.
 * Logged out (`profileId` null), the following pool is empty, and the taste
 * pool only has looks when the phone sent styles.
 */
async function fetchCandidates(
  { db }: FeedDeps,
  profileId: string | null,
  styles: readonly Style[],
): Promise<Record<Pool, Scored[]>> {
  const { poolLimit, followingPerAuthor, freshHours, seenDays } = FEED_RULES;
  const viewer = sql`${profileId}::uuid`;
  const { rows } = await db.execute<CandidateRow>(sql`
    WITH visible AS NOT MATERIALIZED (
      SELECT l.id, l.author_profile_id, l.occasion_tags::text[] AS occasion_tags,
             l.season_tags::text[] AS season_tags, l.style_tags, l.published_at, l.popularity_score
        FROM looks l
       WHERE ${showableLook(sql`l`)}
         AND l.published_at <= now()
         AND l.author_profile_id IS DISTINCT FROM ${viewer}
         -- NOT IN (not NOT EXISTS): read once into a hash, so pools keep walking their index in order.
         AND l.id NOT IN (SELECT s.look_id FROM seen s
                           WHERE s.profile_id = ${viewer}
                             AND s.last_seen_at > now() - make_interval(days => ${seenDays}))
         AND l.id NOT IN (SELECT w.look_id FROM swipes w
                           WHERE w.profile_id = ${viewer} AND w.kind = 'see_less')
    )
    -- Each followed person's newest few, via looks_feed_author_idx (the Following tab has the rest).
    (SELECT 'following' AS pool, v.* FROM follows f
       CROSS JOIN LATERAL (SELECT * FROM visible v WHERE v.author_profile_id = f.followed_profile_id
                            ORDER BY v.published_at DESC, v.id DESC LIMIT ${followingPerAuthor}) v
      WHERE f.follower_profile_id = ${viewer} AND f.deleted_at IS NULL
      ORDER BY v.published_at DESC, v.id DESC LIMIT ${poolLimit})
    UNION ALL
    -- Looks in the picked styles (looks_feed_style_idx). Brands count once looks have products (Phase 3).
    (SELECT 'taste' AS pool, v.* FROM visible v
      WHERE ${inStyles(sql`v`, styles)}
      ORDER BY v.popularity_score DESC, v.published_at DESC, v.id DESC LIMIT ${poolLimit})
    UNION ALL
    (SELECT 'fresh' AS pool, v.* FROM visible v
      WHERE v.published_at > now() - make_interval(hours => ${freshHours})
      ORDER BY v.published_at DESC, v.id DESC LIMIT ${poolLimit})
    UNION ALL
    (SELECT 'popular' AS pool, v.* FROM visible v
      ORDER BY v.popularity_score DESC, v.published_at DESC, v.id DESC LIMIT ${poolLimit})`);

  const pools: Record<Pool, Scored[]> = { following: [], taste: [], fresh: [], popular: [] };
  for (const row of rows) {
    pools[row.pool].push({
      id: row.id,
      authorId: row.author_profile_id,
      similarityKey: similarityKey(row.occasion_tags, row.season_tags),
      score: row.popularity_score,
    });
  }
  return pools;
}

/** Similarity keys of the looks this profile most recently marked "see less like this". */
async function seeLessKeys({ db }: FeedDeps, profileId: string | null): Promise<Set<string>> {
  if (profileId === null) return new Set();
  const { rows } = await db.execute<{ occasion_tags: string[]; season_tags: string[] }>(sql`
    SELECT l.occasion_tags::text[] AS occasion_tags, l.season_tags::text[] AS season_tags
      FROM swipes w JOIN looks l ON l.id = w.look_id
     WHERE w.profile_id = ${profileId} AND w.kind = 'see_less'
     ORDER BY w.updated_at DESC
     LIMIT ${FEED_RULES.seeLessRemembered}`);
  return new Set(rows.flatMap((r) => similarityKey(r.occasion_tags, r.season_tags) ?? []));
}

/**
 * Styles the taste pool matches: the profile's stored taste when it has one,
 * else the ones the phone sent (logged out, or before its picks are uploaded).
 * Values no longer in STYLES are dropped.
 */
async function tasteStyles(
  { db }: FeedDeps,
  profileId: string | null,
  sent: readonly Style[],
): Promise<Style[]> {
  if (profileId !== null) {
    const [stored] = await db
      .select({ styles: tasteProfiles.styles })
      .from(tasteProfiles)
      .where(eq(tasteProfiles.profileId, profileId));
    if (stored) return knownStyles(stored.styles);
  }
  return knownStyles(sent);
}

/**
 * Looks the profile saw between `seenDays` and `refillAfterHours` ago, seen
 * longest ago first: they top up a list when few unseen looks are left, so For
 * You never runs dry (nothing seen in the last day comes back).
 */
async function seenLongAgo(
  { db }: FeedDeps,
  profileId: string,
  limit: number,
): Promise<Candidate[]> {
  const { seenDays, refillAfterHours } = FEED_RULES;
  const { rows } = await db.execute<{
    id: string;
    author_profile_id: string;
    occasion_tags: string[];
    season_tags: string[];
  }>(sql`
    SELECT l.id, l.author_profile_id, l.occasion_tags::text[] AS occasion_tags,
           l.season_tags::text[] AS season_tags
      FROM seen s JOIN looks l ON l.id = s.look_id
     WHERE s.profile_id = ${profileId}
       AND s.last_seen_at > now() - make_interval(days => ${seenDays})
       AND s.last_seen_at <= now() - make_interval(hours => ${refillAfterHours})
       AND ${showableLook(sql`l`)}
       AND l.published_at <= now()
       AND l.author_profile_id <> ${profileId}
       AND l.id NOT IN (SELECT w.look_id FROM swipes w
                         WHERE w.profile_id = ${profileId} AND w.kind = 'see_less')
     ORDER BY s.last_seen_at, l.id
     LIMIT ${limit}`);
  return rows.map((row) => ({
    id: row.id,
    authorId: row.author_profile_id,
    similarityKey: similarityKey(row.occasion_tags, row.season_tags),
  }));
}

/** Ranks a new For You list for this viewer: up to `snapshotSize` look ids, best first. */
async function rankLooks(
  deps: FeedDeps,
  profileId: string | null,
  styles: readonly Style[],
  random: () => number,
): Promise<string[]> {
  const [pools, lessLike] = await Promise.all([
    fetchCandidates(deps, profileId, styles),
    seeLessKeys(deps, profileId),
  ]);
  const mixed = interleave({
    following: demoteSimilar(pools.following, lessLike),
    taste: demoteSimilar(jitter(pools.taste, random), lessLike),
    fresh: demoteSimilar(pools.fresh, lessLike),
    popular: demoteSimilar(jitter(pools.popular, random), lessLike),
  });
  let candidates: Candidate[] = mixed;
  if (profileId !== null && mixed.length < FEED_RULES.snapshotSize) {
    const refill = await seenLongAgo(deps, profileId, FEED_RULES.snapshotSize - mixed.length);
    candidates = [...mixed, ...demoteSimilar(refill, lessLike)];
  }
  return applyDiversity(candidates, FEED_RULES.snapshotSize).map((c) => c.id);
}

/** Saves a list. A profile keeps its newest `listsPerProfile` (each refresh makes one). */
async function saveList(
  db: Db,
  profileId: string | null,
  lookIds: string[],
  tasteKey: string | null = null,
): Promise<string> {
  const [row] = await db
    .insert(feedSnapshots)
    .values({ profileId, lookIds, tasteKey })
    .returning({ id: feedSnapshots.id });
  if (!row) throw new Error('Feed snapshot insert returned no row.');
  if (profileId !== null) {
    const newest = db
      .select({ id: feedSnapshots.id })
      .from(feedSnapshots)
      .where(eq(feedSnapshots.profileId, profileId))
      .orderBy(desc(feedSnapshots.createdAt))
      .limit(FEED_RULES.listsPerProfile);
    await db
      .delete(feedSnapshots)
      .where(and(eq(feedSnapshots.profileId, profileId), notInArray(feedSnapshots.id, newest)));
  }
  return row.id;
}

/** Look ids `from` … `from + count - 1` of a saved list (Postgres arrays are 1-based, slices inclusive). */
function idSlice(from: number, count: number) {
  return sql<string[]>`${feedSnapshots.lookIds}[${from + 1}:${from + count}]`;
}

function readIdsFrom(deps: FeedDeps, listId: string) {
  return async (from: number, count: number): Promise<string[]> => {
    const [row] = await deps.db
      .select({ ids: idSlice(from, count) })
      .from(feedSnapshots)
      .where(eq(feedSnapshots.id, listId));
    return row?.ids ?? [];
  };
}

interface SharedList {
  id: string;
  total: number;
}

/**
 * For a logged-out visitor: one of the shared lists for their styles (none
 * picked: the plain ones) made in the last few minutes, picked at random, or
 * `'new'` while there are fewer than allowed (then one is made). New styled
 * lists have a cap across all style choices, so strangers can't fill the
 * database by trying combinations: past it, the choice's newest list from the
 * day is reused, else they get a plain one (`'plain'`).
 */
async function pickSharedList(
  deps: FeedDeps,
  tasteKey: string | null,
  random: () => number,
): Promise<SharedList | 'new' | 'plain'> {
  const since = (minutes: number) =>
    and(
      isNull(feedSnapshots.profileId),
      gt(feedSnapshots.createdAt, sql`now() - make_interval(mins => ${minutes})`),
    );
  const listsSince = (minutes: number) =>
    deps.db
      .select({ id: feedSnapshots.id, total: sql<number>`cardinality(${feedSnapshots.lookIds})` })
      .from(feedSnapshots)
      .where(
        and(
          since(minutes),
          tasteKey === null ? isNull(feedSnapshots.tasteKey) : eq(feedSnapshots.tasteKey, tasteKey),
        ),
      )
      .orderBy(desc(feedSnapshots.createdAt));

  const { sharedLists, sharedListsPerTaste, sharedListMinutes, styledListsPerWindow } = FEED_RULES;
  const recent = await listsSince(sharedListMinutes);
  const wanted = tasteKey === null ? sharedLists : sharedListsPerTaste;
  if (recent.length >= wanted) return recent[Math.floor(random() * recent.length)] ?? 'new';
  if (tasteKey === null) return 'new';
  const styledLately = await deps.db.$count(
    feedSnapshots,
    and(since(sharedListMinutes), isNotNull(feedSnapshots.tasteKey)),
  );
  if (styledLately < styledListsPerWindow) return 'new';
  const [newest] = await listsSince(24 * 60).limit(1);
  return newest ?? 'plain';
}

/**
 * Fills a page from position `start` of a list with `total` looks, reading
 * ids in chunks. Looks hidden since the list was made are skipped, so the
 * page still gets FEED_PAGE_SIZE cards while the list has them.
 */
async function fillPage(
  deps: FeedDeps,
  profileId: string | null,
  listId: string,
  start: number,
  total: number,
  readIds: (from: number, count: number) => Promise<readonly string[]>,
): Promise<FeedPage> {
  const items: FeedCard[] = [];
  let next = start;
  while (items.length < FEED_PAGE_SIZE && next < total) {
    const ids = await readIds(next, FEED_PAGE_SIZE * 2);
    if (ids.length === 0) break;
    const cards = await loadCards(deps, ids, profileId);
    for (const id of ids) {
      next++;
      const card = cards.get(id);
      if (card) items.push(card);
      if (items.length === FEED_PAGE_SIZE) break;
    }
  }
  return { items, nextCursor: next < total ? encodeCursor({ s: listId, i: next }) : null };
}

/**
 * Page 1: a shared recent list when logged out (once there are enough for
 * their styles), else a new one.
 */
async function firstPage(
  deps: FeedDeps,
  profileId: string | null,
  sentStyles: readonly Style[],
  random: () => number,
): Promise<FeedPage> {
  const styles = await tasteStyles(deps, profileId, sentStyles);
  const tasteKey = profileId === null && styles.length > 0 ? styles.join(',') : null;
  if (profileId === null) {
    const shared = await pickSharedList(deps, tasteKey, random);
    if (shared === 'plain') return firstPage(deps, null, [], random);
    if (shared !== 'new') {
      return fillPage(deps, null, shared.id, 0, shared.total, readIdsFrom(deps, shared.id));
    }
  }
  const lookIds = await rankLooks(deps, profileId, styles, random);
  if (lookIds.length === 0) return { items: [], nextCursor: null };
  const listId = await saveList(deps.db, profileId, lookIds, tasteKey);
  return fillPage(deps, profileId, listId, 0, lookIds.length, (from, count) =>
    Promise.resolve(lookIds.slice(from, from + count)),
  );
}

export interface ForYouOptions {
  /** Randomness for the light reshuffle and the shared-list pick (tests pass a fixed one). */
  random?: () => number;
  /** Styles picked on the phone (`?styles=`); a profile's stored taste wins over them. */
  styles?: readonly Style[];
}

/**
 * One page of For You. The first page ranks a list of up to 400 looks and
 * saves it (logged-out visitors share a few recent ones); later pages read on
 * from the cursor's position, so a look never repeats or gets skipped even
 * when scores change meanwhile. A list that is gone (deleted after a day, or
 * one of a profile's older ones) or belongs to another profile starts a new
 * one; a logged-out list may be continued once a guest login exists.
 */
export async function forYouPage(
  deps: FeedDeps,
  profileId: string | null,
  cursor: string | undefined,
  { random = Math.random, styles = [] }: ForYouOptions = {},
): Promise<FeedPage> {
  if (cursor === undefined) return firstPage(deps, profileId, styles, random);
  const { s, i } = decodeCursor(cursorSchema, cursor);
  // One round trip: the owner, the length and the ids this page most likely needs.
  const [list] = await deps.db
    .select({
      profileId: feedSnapshots.profileId,
      total: sql<number>`cardinality(${feedSnapshots.lookIds})`,
      ids: idSlice(i, FEED_PAGE_SIZE * 2),
    })
    .from(feedSnapshots)
    .where(eq(feedSnapshots.id, s));
  if (!list || (list.profileId !== null && list.profileId !== profileId)) {
    return firstPage(deps, profileId, styles, random);
  }
  const readMore = readIdsFrom(deps, s);
  return fillPage(deps, profileId, s, i, list.total, (from, count) =>
    from === i ? Promise.resolve(list.ids) : readMore(from, count),
  );
}
