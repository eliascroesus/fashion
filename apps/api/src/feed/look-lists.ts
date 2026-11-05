// The ranked lists behind "More like this" and search (`look_lists`): page 1 makes one (or
// reuses a recent one), later pages read on from the cursor's place in it.
import { and, type Db, desc, eq, gt, isNull, lookLists, lt, notInArray, sql } from '@outfitly/db';
import { FEED_PAGE_SIZE, type FeedCard, type FeedPage } from '@outfitly/shared';
import { z } from 'zod';
import { decodeCursor, encodeCursor, type FeedDeps, loadCards } from './cards.ts';

export type LookListKind = 'similar' | 'search';

export const LIST_RULES = {
  /** Looks in one list (20 pages). */
  size: 400,
  /** A list is reused for the same look or words for this long (so going back and forth is free). */
  reuseMinutes: 15,
  /** A profile keeps its newest this-many lists of a kind; older ones go. */
  perProfile: 20,
} as const;

/** Where the next page starts: a place in a saved list. */
const cursorSchema = z.object({
  l: z.uuid(),
  i: z.number().int().positive().max(LIST_RULES.size),
});

export interface SavedList {
  id: string;
  total: number;
}

/**
 * The newest reusable list of this kind for `key`: the profile's own (any),
 * or, for `profileId` null, a shared one that is complete.
 */
export async function recentList(
  db: Db,
  kind: LookListKind,
  key: string,
  profileId: string | null,
): Promise<SavedList | null> {
  const [row] = await db
    .select({ id: lookLists.id, total: sql<number>`cardinality(${lookLists.lookIds})` })
    .from(lookLists)
    .where(
      and(
        eq(lookLists.kind, kind),
        eq(lookLists.key, key),
        profileId === null
          ? and(isNull(lookLists.profileId), eq(lookLists.complete, true))
          : eq(lookLists.profileId, profileId),
        gt(lookLists.createdAt, sql`now() - make_interval(mins => ${LIST_RULES.reuseMinutes})`),
      ),
    )
    .orderBy(desc(lookLists.createdAt))
    .limit(1);
  return row ?? null;
}

/** Saves a list. A profile keeps its newest `perProfile` lists of each kind. */
export async function saveList(
  db: Db,
  kind: LookListKind,
  key: string,
  profileId: string | null,
  lookIds: readonly string[],
  complete: boolean,
): Promise<string> {
  const [row] = await db
    .insert(lookLists)
    .values({ kind, key, profileId, lookIds: [...lookIds], complete })
    .returning({ id: lookLists.id });
  if (!row) throw new Error('Look list insert returned no row.');
  if (profileId !== null) {
    const newest = db
      .select({ id: lookLists.id })
      .from(lookLists)
      .where(and(eq(lookLists.kind, kind), eq(lookLists.profileId, profileId)))
      .orderBy(desc(lookLists.createdAt))
      .limit(LIST_RULES.perProfile);
    await db
      .delete(lookLists)
      .where(
        and(
          eq(lookLists.kind, kind),
          eq(lookLists.profileId, profileId),
          notInArray(lookLists.id, newest),
        ),
      );
  }
  return row.id;
}

/** Look ids `from` … `from + count - 1` of a saved list (Postgres arrays are 1-based, slices inclusive). */
function idSlice(from: number, count: number) {
  return sql<string[]>`${lookLists.lookIds}[${from + 1}:${from + count}]`;
}

/**
 * A page from place `start` of a list with `total` looks. Looks hidden since
 * the list was made are skipped, so the page still gets FEED_PAGE_SIZE cards
 * while the list has them.
 */
async function fillPage(
  deps: FeedDeps,
  viewerProfileId: string | null,
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
    const cards = await loadCards(deps, ids, viewerProfileId);
    for (const id of ids) {
      next++;
      const card = cards.get(id);
      if (card) items.push(card);
      if (items.length === FEED_PAGE_SIZE) break;
    }
  }
  return { items, nextCursor: next < total ? encodeCursor({ l: listId, i: next }) : null };
}

/** The first page of a list just made (its ids are at hand) or reused. */
export function firstListPage(
  deps: FeedDeps,
  viewerProfileId: string | null,
  list: SavedList & { lookIds?: readonly string[] },
): Promise<FeedPage> {
  const { lookIds } = list;
  return fillPage(deps, viewerProfileId, list.id, 0, list.total, (from, count) =>
    lookIds
      ? Promise.resolve(lookIds.slice(from, from + count))
      : readSlice(deps.db, list.id)(from, count),
  );
}

function readSlice(db: Db, listId: string) {
  return async (from: number, count: number): Promise<string[]> => {
    const [row] = await db
      .select({ ids: idSlice(from, count) })
      .from(lookLists)
      .where(eq(lookLists.id, listId));
    return row?.ids ?? [];
  };
}

/**
 * The page a cursor points at, or null when its list is gone (deleted after
 * a day, or one of a profile's older ones), belongs to someone else, or is
 * another kind or key (a cursor from another look's "More like this"): the
 * caller then starts a new list.
 */
export async function nextListPage(
  deps: FeedDeps,
  viewerProfileId: string | null,
  kind: LookListKind,
  key: string,
  cursor: string,
): Promise<FeedPage | null> {
  const { l, i } = decodeCursor(cursorSchema, cursor);
  // One round trip: the owner, the length and the ids this page most likely needs.
  const [list] = await deps.db
    .select({
      kind: lookLists.kind,
      key: lookLists.key,
      profileId: lookLists.profileId,
      total: sql<number>`cardinality(${lookLists.lookIds})`,
      ids: idSlice(i, FEED_PAGE_SIZE * 2),
    })
    .from(lookLists)
    .where(eq(lookLists.id, l));
  if (!list || list.kind !== kind || list.key !== key) return null;
  if (list.profileId !== null && list.profileId !== viewerProfileId) return null;
  const readMore = readSlice(deps.db, l);
  return fillPage(deps, viewerProfileId, l, i, list.total, (from, count) =>
    from === i ? Promise.resolve(list.ids) : readMore(from, count),
  );
}

/** Deletes lists older than a day. Returns how many. */
export async function deleteOldLookLists(db: Db): Promise<number> {
  const result = await db
    .delete(lookLists)
    .where(lt(lookLists.createdAt, sql`now() - interval '1 day'`));
  return result.rowCount ?? 0;
}
