import type { FeedCard, FeedPage, Me } from '@outfitly/shared';
import type { InfiniteData, QueryClient, QueryKey } from '@tanstack/react-query';
import { LOOK_QUERY_ROOT, SIMILAR_QUERY_ROOT } from '../looks/keys';
import { CARD_LIST_ROOTS } from '../saves/keys';
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

/**
 * The first save logs a visitor in (a guest): what they are looking at
 * carries on under the new profile instead of reloading, so nothing jumps.
 * That's the For You being scrolled (the server lets a logged-out list
 * continue once there is a login) and any open look page with its "More
 * like this". Only for a brand-new guest: an existing account gets its own.
 */
export function carryOverLoggedOutData(queryClient: QueryClient, from: Me | null, to: Me): void {
  const profileId = to.activeProfileId;
  if (from?.activeProfileId || !profileId || !to.isAnonymous) return;
  copyQuery(queryClient, feedQueryKey('for-you', null), feedQueryKey('for-you', profileId));
  for (const root of [LOOK_QUERY_ROOT, SIMILAR_QUERY_ROOT]) {
    for (const query of queryClient.getQueryCache().findAll({ queryKey: [root, 'anon'] })) {
      const [, , lookId] = query.queryKey;
      if (typeof lookId === 'string')
        copyQuery(queryClient, query.queryKey, [root, profileId, lookId]);
    }
  }
}
