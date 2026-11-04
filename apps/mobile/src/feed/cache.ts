import type { FeedCard, FeedPage, Me } from '@outfitly/shared';
import type { InfiniteData, QueryClient, QueryKey } from '@tanstack/react-query';
import { LOOK_QUERY_ROOT, SIMILAR_QUERY_ROOT } from '../looks/keys';
import { PROFILE_LOOKS_QUERY_ROOT, PROFILE_QUERY_ROOT } from '../profiles/keys';
import { CARD_LIST_ROOTS } from '../saves/keys';
import { SEARCH_QUERY_ROOT } from '../search/keys';
import { feedQueryKey } from './keys';

/**
 * Shows a new list (its first page) instead of the cached one. A next page
 * of the old list still loading is cancelled first, so it can't land on top.
 */
export async function replaceFeed(
  queryClient: QueryClient,
  queryKey: QueryKey,
  first: FeedPage,
): Promise<void> {
  await queryClient.cancelQueries({ queryKey });
  queryClient.setQueryData<InfiniteData<FeedPage, string | null>>(queryKey, {
    pages: [first],
    pageParams: [null],
  });
}

/** A feed's first page, tagged with the list it starts (see startList). */
export type FirstPage = FeedPage & { listId?: string };

let listsStarted = 0;

/**
 * Tags the first page of a new list (first load, refresh, cold-start swap),
 * even when it holds the same looks as before. Saving a look or "see less"
 * rewrites the page but keeps the tag, so the grid only starts over for a new list.
 */
export function startList(first: FeedPage): FirstPage {
  listsStarted += 1;
  return { ...first, listId: `${String(Date.now())}-${String(listsStarted)}` };
}

/** Which list a feed shows (see startList); stored lists keep it across launches. */
export function listIdentity(firstPage: FirstPage | undefined): string | undefined {
  return firstPage?.listId;
}

/**
 * A card already in one of the cached lists (feeds, Saves, boards), so the
 * look screen shows its photo at once.
 */
export function findCachedCard(queryClient: QueryClient, lookId: string): FeedCard | undefined {
  for (const root of CARD_LIST_ROOTS) {
    const lists = queryClient.getQueriesData<InfiniteData<FeedPage>>({ queryKey: [root] });
    for (const [, data] of lists) {
      for (const page of data?.pages ?? []) {
        const card = page.items.find((c) => c.id === lookId);
        if (card) return card;
      }
    }
  }
  return undefined;
}

/** Copies cached data to another key, keeping its age (a stale copy still refreshes as before). */
function copyQuery(queryClient: QueryClient, from: QueryKey, to: QueryKey): void {
  const source = queryClient.getQueryState(from);
  if (!source?.data || queryClient.getQueryData(to) !== undefined) return;
  queryClient.setQueryData(to, source.data, { updatedAt: source.dataUpdatedAt });
}

/** Per-viewer data keyed `[root, 'anon', id or text]` when logged out. */
const CARRIED_ROOTS = [
  LOOK_QUERY_ROOT,
  SIMILAR_QUERY_ROOT,
  SEARCH_QUERY_ROOT,
  PROFILE_QUERY_ROOT,
  PROFILE_LOOKS_QUERY_ROOT,
];

/**
 * The first save logs a visitor in (a guest): what they are looking at
 * carries on under the new profile instead of reloading, so nothing jumps.
 * That's the For You being scrolled (the server lets a logged-out list
 * continue once there is a login), any open look page with its "More like
 * this", search results and profiles. Only for a brand-new guest: an
 * existing account gets its own.
 */
export function carryOverLoggedOutData(queryClient: QueryClient, from: Me | null, to: Me): void {
  const profileId = to.activeProfileId;
  if (from?.activeProfileId || !profileId || !to.isAnonymous) return;
  copyQuery(queryClient, feedQueryKey('for-you', null), feedQueryKey('for-you', profileId));
  for (const root of CARRIED_ROOTS) {
    for (const query of queryClient.getQueryCache().findAll({ queryKey: [root, 'anon'] })) {
      const [, , what] = query.queryKey;
      if (typeof what === 'string') copyQuery(queryClient, query.queryKey, [root, profileId, what]);
    }
  }
}
