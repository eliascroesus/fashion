import type { Board, FeedCard, FeedPage } from '@outfitly/shared';
import {
  type QueryKey,
  useInfiniteQuery,
  useMutation,
  useQuery,
  useQueryClient,
} from '@tanstack/react-query';
import { randomUUID } from 'expo-crypto';
import { useCallback, useMemo, useRef, useState } from 'react';
import { api } from '../api';
import { useMe } from '../auth/store';
import { dedupeCards } from '../feed/layout';
import { useOutboxView } from './index';
import {
  BOARD_LOOKS_QUERY_ROOT,
  boardLooksQueryKey,
  BOARDS_QUERY_ROOT,
  boardsQueryKey,
  savesQueryKey,
} from './keys';

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
 * A saved list (Saves, or a board's looks), as it will be once everything
 * waiting on the phone is sent: waiting saves first, undone ones left out.
 */
function useSavedList(
  queryKey: QueryKey,
  fetchPage: (cursor: string | undefined, signal: AbortSignal) => Promise<FeedPage>,
  options: { enabled: boolean; boardId?: string },
): CardList {
  const query = useInfiniteQuery({
    queryKey,
    queryFn: ({ pageParam, signal }) => fetchPage(pageParam ?? undefined, signal),
    initialPageParam: null as string | null,
    getNextPageParam: (last) => last.nextCursor,
    enabled: options.enabled,
  });
  const waiting = useOutboxView();
  const { boardId } = options;
  const cards = useMemo(() => {
    const kept = dedupeCards(query.data?.pages ?? []).filter((card) =>
      boardId === undefined
        ? (waiting.savedState(card.id) ?? card.saved)
        : (waiting.boardState(boardId, card.id) ?? true),
    );
    const listed = new Set(kept.map((c) => c.id));
    return [...waiting.waitingCards(boardId).filter((c) => !listed.has(c.id)), ...kept];
  }, [query.data, waiting, boardId]);

  const [refreshing, setRefreshing] = useState(false);
  const { refetch, fetchNextPage, hasNextPage, isFetchingNextPage, isFetchNextPageError } = query;
  const { enabled } = options;
  const refresh = useCallback(async () => {
    // Logged out there is nothing on the server yet (refetch would ignore `enabled`).
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
    // Logged out there is nothing to load: not "loading".
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

/** Everything the active profile saved, newest first. */
export function useSaves(): CardList {
  const profileId = useMe()?.activeProfileId ?? null;
  return useSavedList(
    savesQueryKey(profileId),
    (cursor, signal) => api.saves.list(cursor, signal),
    { enabled: profileId !== null },
  );
}

export function useBoardLooks(boardId: string): CardList {
  const profileId = useMe()?.activeProfileId ?? null;
  return useSavedList(
    boardLooksQueryKey(profileId, boardId),
    (cursor, signal) => api.boards.looks(boardId, cursor, signal),
    { enabled: profileId !== null, boardId },
  );
}

/**
 * The active profile's boards. With `lookId`, each says whether it holds that
 * look, counting actions still waiting on the phone (the board picker).
 */
export function useBoards(lookId?: string) {
  const profileId = useMe()?.activeProfileId ?? null;
  const query = useQuery({
    queryKey: boardsQueryKey(profileId, lookId),
    queryFn: ({ signal }) => api.boards.list(lookId, signal),
    enabled: profileId !== null,
    // The picker must show today's ticks, not a cached guess.
    ...(lookId ? { staleTime: 0 } : {}),
  });
  const waiting = useOutboxView();
  const boards = useMemo(() => {
    const items = query.data?.items ?? [];
    if (!lookId) return items;
    return items.map((board) => ({
      ...board,
      hasLook: waiting.boardState(board.id, lookId) ?? board.hasLook ?? false,
    }));
  }, [query.data, waiting, lookId]);
  return { boards, query };
}

/**
 * One Idempotency-Key per user action, kept while the same action is retried
 * (a second tap on "Create" after a timeout must not make two boards). A
 * different request (e.g. another name) gets a new key.
 */
function useActionKey() {
  const key = useRef<{ request: string; value: string } | null>(null);
  return {
    for: (request: string) => {
      if (key.current?.request !== request) key.current = { request, value: randomUUID() };
      return key.current.value;
    },
    done: () => {
      key.current = null;
    },
  };
}

/** Create, rename and delete boards. These need a connection (the screens say so offline). */
export function useBoardMutations() {
  const queryClient = useQueryClient();
  const createKey = useActionKey();
  const renameKey = useActionKey();
  const deleteKey = useActionKey();
  const refreshBoards = () => queryClient.invalidateQueries({ queryKey: [BOARDS_QUERY_ROOT] });

  const create = useMutation({
    mutationFn: (name: string): Promise<Board> => api.boards.create(name, createKey.for(name)),
    onSuccess: () => {
      createKey.done();
      return refreshBoards();
    },
  });
  const rename = useMutation({
    mutationFn: ({ boardId, name }: { boardId: string; name: string }) =>
      api.boards.rename(boardId, name, renameKey.for(`${boardId}/${name}`)),
    onSuccess: () => {
      renameKey.done();
      return refreshBoards();
    },
  });
  const remove = useMutation({
    mutationFn: (boardId: string) => api.boards.remove(boardId, deleteKey.for(boardId)),
    onSuccess: (_result, boardId) => {
      deleteKey.done();
      queryClient.removeQueries({
        queryKey: [BOARD_LOOKS_QUERY_ROOT],
        predicate: (q) => q.queryKey[2] === boardId,
      });
      return refreshBoards();
    },
  });
  return { create, rename, remove };
}
