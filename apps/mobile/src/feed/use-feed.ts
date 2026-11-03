import type { FeedPage } from '@outfitly/shared';
import { type InfiniteData, useInfiniteQuery, useQueryClient } from '@tanstack/react-query';
import { useCallback, useEffect, useMemo, useState } from 'react';
import { api } from '../api';
import { useMe } from '../auth/store';
import { type FeedKind, feedQueryKey } from './keys';
import { dedupeCards } from './layout';

type FeedData = InfiniteData<FeedPage, string | null>;

/** Cached feeds older than this were restored from the phone at a cold start. */
const LAUNCHED_AT = Date.now();
/** Feeds already refreshed once after the cold start. */
const refreshedThisLaunch = new Set<string>();

function fetchPage(kind: FeedKind, cursor: string | null): Promise<FeedPage> {
  const page = cursor ?? undefined;
  return kind === 'for-you' ? api.feed.forYou(page) : api.feed.following(page);
}

interface Options {
  enabled: boolean;
  /**
   * Whether a fresh list may replace the one on screen without the user
   * losing their place. Keep it stable (useCallback reading refs).
   */
  isNearTop: () => boolean;
}

/**
 * One home feed: the pages so far as one list of cards, next pages on
 * demand, and pull to refresh. At a cold start the feed stored on the phone
 * shows at once; a fresh one replaces it if the user hasn't started scrolling.
 */
export function useFeed(kind: FeedKind, { enabled, isNearTop }: Options) {
  const queryClient = useQueryClient();
  const profileId = useMe()?.activeProfileId ?? null;
  const queryKey = useMemo(() => feedQueryKey(kind, profileId), [kind, profileId]);

  const query = useInfiniteQuery({
    queryKey,
    queryFn: ({ pageParam }) => fetchPage(kind, pageParam),
    initialPageParam: null as string | null,
    getNextPageParam: (last) => last.nextCursor,
    enabled,
    // Never refetched automatically: that would mix a new page 1 with the old
    // list's cursors. A new list only comes from replaceWithNewList.
    staleTime: Infinity,
    refetchOnMount: false,
    refetchOnReconnect: false,
    refetchOnWindowFocus: false,
  });
  const cards = useMemo(() => dedupeCards(query.data?.pages ?? []), [query.data]);
  const [refreshing, setRefreshing] = useState(false);

  /** Fetches a new list's first page and shows it instead of the current list. */
  const replaceWithNewList = useCallback(
    async (onlyNearTop: boolean): Promise<void> => {
      const first = await fetchPage(kind, null);
      if (onlyNearTop && !isNearTop()) return;
      // A next page still loading belongs to the old list.
      await queryClient.cancelQueries({ queryKey });
      queryClient.setQueryData<FeedData>(queryKey, { pages: [first], pageParams: [null] });
    },
    [kind, queryClient, queryKey, isNearTop],
  );

  useEffect(() => {
    const id = queryKey.join('/');
    if (!enabled || !query.data || query.dataUpdatedAt >= LAUNCHED_AT) return;
    if (refreshedThisLaunch.has(id)) return;
    refreshedThisLaunch.add(id);
    // Offline: keep showing the stored feed.
    replaceWithNewList(true).catch(() => undefined);
  }, [enabled, query.data, query.dataUpdatedAt, queryKey, replaceWithNewList]);

  const refresh = useCallback(async () => {
    setRefreshing(true);
    try {
      await replaceWithNewList(false);
    } catch {
      // Offline or the server is down: the current list stays.
    } finally {
      setRefreshing(false);
    }
  }, [replaceWithNewList]);

  const { hasNextPage, isFetchingNextPage, isFetchNextPageError, fetchNextPage } = query;
  /** Next page, unless one is loading, the list ended, or the last try failed (then: retry). */
  const loadMore = useCallback(() => {
    if (hasNextPage && !isFetchingNextPage && !isFetchNextPageError) void fetchNextPage();
  }, [hasNextPage, isFetchingNextPage, isFetchNextPageError, fetchNextPage]);

  return {
    cards,
    /** Changes when a new list replaces the old one (refresh): impressions count afresh. */
    firstPage: query.data?.pages[0],
    isPending: query.isPending,
    /** The first page failed and nothing is stored to show instead. */
    isError: query.isError && !query.data,
    hasNextPage,
    isFetchingNextPage,
    isFetchNextPageError,
    loadMore,
    retryNextPage: () => void fetchNextPage(),
    retry: () => void query.refetch(),
    refreshing,
    refresh,
  };
}
