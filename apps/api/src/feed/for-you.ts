import { and, type Db, desc, eq, feedSnapshots, gt, isNull, notInArray, sql } from '@outfitly/db';
import { FEED_PAGE_SIZE, type FeedCard, type FeedPage } from '@outfitly/shared';
import { z } from 'zod';
import {
  applyDiversity,
  type Candidate,
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
 * Up to `poolLimit` candidates from each of the four pools, in one round trip.
 * Each pool walks its own index (see looks_feed_*_idx) and stops early.
 * Logged out (`profileId` null), only the fresh and popular pools return rows.
 */
async function fetchCandidates(
  { db }: FeedDeps,
  profileId: string | null,
): Promise<Record<Pool, Scored[]>> {
  const { poolLimit, followingPerAuthor, freshHours, seenDays } = FEED_RULES;
  const viewer = sql`${profileId}::uuid`;
  const { rows } = await db.execute<CandidateRow>(sql`
    WITH visible AS NOT MATERIALIZED (
      SELECT l.id, l.author_profile_id, l.occasion_tags::text[] AS occasion_tags,
             l.season_tags::text[] AS season_tags, l.published_at, l.popularity_score
        FROM looks l
       WHERE ${showableLook(sql`l`)}
         AND l.published_at <= now()
         AND l.author_profile_id IS DISTINCT FROM ${viewer}
         -- NOT IN (not NOT EXISTS): read once into a hash, so pools keep walking their index in order.
         AND l.id NOT IN (SELECT s.look_id FROM seen s
                           WHERE s.profile_id = ${viewer}
                             AND s.last_seen_at > now() - make_interval(days => ${seenDays}))
    )
    -- Each followed person's newest few, via looks_feed_author_idx (the Following tab has the rest).
    (SELECT 'following' AS pool, v.* FROM follows f
       CROSS JOIN LATERAL (SELECT * FROM visible v WHERE v.author_profile_id = f.followed_profile_id
                            ORDER BY v.published_at DESC, v.id DESC LIMIT ${followingPerAuthor}) v
      WHERE f.follower_profile_id = ${viewer} AND f.deleted_at IS NULL
      ORDER BY v.published_at DESC, v.id DESC LIMIT ${poolLimit})
    UNION ALL
    -- Brands count once looks have products (Phase 3).
    (SELECT 'taste' AS pool, v.* FROM visible v, taste_profiles t
      WHERE t.profile_id = ${viewer} AND cardinality(t.styles) > 0
        AND (v.occasion_tags || v.season_tags) && t.styles
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

/** Ranks a new For You list for this viewer: up to `snapshotSize` look ids, best first. */
async function rankLooks(
  deps: FeedDeps,
  profileId: string | null,
  random: () => number,
): Promise<string[]> {
  const pools = await fetchCandidates(deps, profileId);
  const mixed = interleave({
    ...pools,
    taste: jitter(pools.taste, random),
    popular: jitter(pools.popular, random),
  });
  return applyDiversity(mixed, FEED_RULES.snapshotSize).map((c) => c.id);
}

/** Saves a list. A profile keeps its newest `listsPerProfile` (each refresh makes one). */
async function saveList(db: Db, profileId: string | null, lookIds: string[]): Promise<string> {
  const [row] = await db
    .insert(feedSnapshots)
    .values({ profileId, lookIds })
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

/**
 * One of the shared logged-out lists made in the last few minutes, picked at
 * random; null while there are fewer than `sharedLists` (then a new one is made).
 */
async function pickSharedList(
  deps: FeedDeps,
  random: () => number,
): Promise<{ id: string; total: number } | null> {
  const recent = await deps.db
    .select({ id: feedSnapshots.id, total: sql<number>`cardinality(${feedSnapshots.lookIds})` })
    .from(feedSnapshots)
    .where(
      and(
        isNull(feedSnapshots.profileId),
        gt(
          feedSnapshots.createdAt,
          sql`now() - make_interval(mins => ${FEED_RULES.sharedListMinutes})`,
        ),
      ),
    );
  if (recent.length < FEED_RULES.sharedLists) return null;
  return recent[Math.floor(random() * recent.length)] ?? null;
}

/**
 * Fills a page from position `start` of a list with `total` looks, reading
 * ids in chunks. Looks hidden since the list was made are skipped, so the
 * page still gets FEED_PAGE_SIZE cards while the list has them.
 */
async function fillPage(
  deps: FeedDeps,
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
    const cards = await loadCards(deps, ids);
    for (const id of ids) {
      next++;
      const card = cards.get(id);
      if (card) items.push(card);
      if (items.length === FEED_PAGE_SIZE) break;
    }
  }
  return { items, nextCursor: next < total ? encodeCursor({ s: listId, i: next }) : null };
}

/** Page 1: a shared recent list when logged out (once there are enough), else a new one. */
async function firstPage(
  deps: FeedDeps,
  profileId: string | null,
  random: () => number,
): Promise<FeedPage> {
  if (profileId === null) {
    const shared = await pickSharedList(deps, random);
    if (shared) return fillPage(deps, shared.id, 0, shared.total, readIdsFrom(deps, shared.id));
  }
  const lookIds = await rankLooks(deps, profileId, random);
  if (lookIds.length === 0) return { items: [], nextCursor: null };
  const listId = await saveList(deps.db, profileId, lookIds);
  return fillPage(deps, listId, 0, lookIds.length, (from, count) =>
    Promise.resolve(lookIds.slice(from, from + count)),
  );
}

export interface ForYouOptions {
  /** Randomness for the light reshuffle and the shared-list pick (tests pass a fixed one). */
  random?: () => number;
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
  { random = Math.random }: ForYouOptions = {},
): Promise<FeedPage> {
  if (cursor === undefined) return firstPage(deps, profileId, random);
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
    return firstPage(deps, profileId, random);
  }
  const readMore = readIdsFrom(deps, s);
  return fillPage(deps, s, i, list.total, (from, count) =>
    from === i ? Promise.resolve(list.ids) : readMore(from, count),
  );
}
