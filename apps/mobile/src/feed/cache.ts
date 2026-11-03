import type { FeedCard, FeedPage } from '@outfitly/shared';
import type { InfiniteData, QueryClient, QueryKey } from '@tanstack/react-query';
import { FEED_QUERY_ROOT } from './keys';

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

/** A card already in one of the cached feeds (the look screen shows its photo at once). */
export function findCachedCard(queryClient: QueryClient, lookId: string): FeedCard | undefined {
  const feeds = queryClient.getQueriesData<InfiniteData<FeedPage>>({ queryKey: [FEED_QUERY_ROOT] });
  for (const [, data] of feeds) {
    for (const page of data?.pages ?? []) {
      const card = page.items.find((c) => c.id === lookId);
      if (card) return card;
    }
  }
  return undefined;
}
