import type { FeedCard, FeedPage } from '@outfitly/shared';
import type { InfiniteData, QueryClient } from '@tanstack/react-query';
import { FEED_QUERY_ROOT } from './keys';

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
