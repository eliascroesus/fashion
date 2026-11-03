import type { FeedCard, FeedPage, Me } from '@outfitly/shared';
import type { InfiniteData, QueryClient, QueryKey } from '@tanstack/react-query';
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

/**
 * The first save logs a visitor in (a guest): their For You carries on under
 * the new profile instead of starting over, so the grid doesn't jump. The
 * server lets a logged-out list continue once there is a login.
 */
export function carryOverLoggedOutFeed(queryClient: QueryClient, from: Me | null, to: Me): void {
  // Only a brand-new guest: an existing account gets its own feed (its saves, taste, follows).
  if (from?.activeProfileId || !to.activeProfileId || !to.isAnonymous) return;
  const source = queryClient.getQueryState(feedQueryKey('for-you', null));
  const target = feedQueryKey('for-you', to.activeProfileId);
  if (!source?.data || queryClient.getQueryData(target) !== undefined) return;
  // Same age as the original, so a stored feed still gets its cold-start refresh.
  queryClient.setQueryData(target, source.data, { updatedAt: source.dataUpdatedAt });
}
