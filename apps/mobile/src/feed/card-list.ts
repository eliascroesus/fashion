import type { FeedCard, FeedPage } from '@outfitly/shared';
import { type QueryKey, useInfiniteQuery } from '@tanstack/react-query';
import { useCallback, useMemo, useState } from 'react';
import { dedupeCards } from './layout';

/** What a look grid needs from a paged list of cards. */
export interface CardList {
  cards: FeedCard[];
  isPending: boolean;
  /** The first page failed and nothing is cached to show instead. */
  isError: boolean;
  hasNextPage: boolean;
  isFetchingNextPage: boolean;
  isFetchNextPageError: boolean;
  loadMore: () => void;
  retryNextPage: () => void;
  retry: () => void;
  refreshing: boolean;
  refresh: () => Promise<void>;
}

/**
 * A list of cards loaded page by page with a cursor (Saves, a board, "more
 * like this"). `adjust` (keep it stable) may filter or add cards, e.g. saves
 * still waiting on the phone. Pull to refresh reloads the pages loaded so far.
 */
export function usePagedCards(
  queryKey: QueryKey,
  fetchPage: (cursor: string | undefined, signal: AbortSignal) => Promise<FeedPage>,
  enabled: boolean,
  adjust?: (cards: FeedCard[]) => FeedCard[],
): CardList {
  const query = useInfiniteQuery({
    queryKey,
    queryFn: ({ pageParam, signal }) => fetchPage(pageParam ?? undefined, signal),
    initialPageParam: null as string | null,
    getNextPageParam: (last) => last.nextCursor,
    enabled,
  });
  const cards = useMemo(() => {
    const all = dedupeCards(query.data?.pages ?? []);
    return adjust ? adjust(all) : all;
  }, [query.data, adjust]);

  const [refreshing, setRefreshing] = useState(false);
  const { refetch, fetchNextPage, hasNextPage, isFetchingNextPage, isFetchNextPageError } = query;
  const refresh = useCallback(async () => {
    // Nothing to load while disabled (refetch would ignore `enabled`).
    if (!enabled) return;
    setRefreshing(true);
    try {
      await refetch();
    } finally {
      setRefreshing(false);
    }
  }, [refetch, enabled]);
  const loadMore = useCallback(() => {
    if (hasNextPage && !isFetchingNextPage && !isFetchNextPageError) void fetchNextPage();
  }, [hasNextPage, isFetchingNextPage, isFetchNextPageError, fetchNextPage]);

  return {
    cards,
    // Disabled (e.g. logged out) there is nothing to load: not "loading".
    isPending: enabled && query.isPending,
    isError: query.isError && !query.data,
    hasNextPage,
    isFetchingNextPage,
    isFetchNextPageError,
    loadMore,
    retryNextPage: () => void fetchNextPage(),
    retry: () => {
      if (enabled) void refetch();
    },
    refreshing,
    refresh,
  };
}
