import type { SimilarPieceSort } from '@outfitly/shared';
import { useInfiniteQuery, useQuery } from '@tanstack/react-query';
import { useMemo } from 'react';
import { api } from '../api';
import { useMe } from '../auth/store';
import { type CardList, usePagedCards } from '../feed/card-list';
import { lookQueryKey, similarPiecesQueryKey, similarQueryKey } from './keys';
import { uniquePieces } from './similar';

/** Everything the look page shows (photos, poster, caption), cached on the phone. */
export function useLookDetail(lookId: string) {
  const profileId = useMe()?.activeProfileId ?? null;
  return useQuery({
    queryKey: lookQueryKey(profileId, lookId),
    queryFn: ({ signal }) => api.looks.get(lookId, signal),
  });
}

/** "More like this" under a look, 20 at a time. */
export function useSimilarLooks(lookId: string): CardList {
  const profileId = useMe()?.activeProfileId ?? null;
  return usePagedCards(
    similarQueryKey(profileId, lookId),
    (cursor, signal) => api.looks.similar(lookId, cursor, signal),
    true,
  );
}

/** "Similar pieces" for one of a look's pieces, 20 at a time; repeats across pages are dropped. */
export function useSimilarPieces(itemId: string, sort: SimilarPieceSort) {
  const query = useInfiniteQuery({
    queryKey: similarPiecesQueryKey(itemId, sort),
    queryFn: ({ pageParam, signal }) =>
      api.looks.similarPieces(itemId, sort, pageParam ?? undefined, signal),
    initialPageParam: null as string | null,
    getNextPageParam: (last) => last.nextCursor,
  });
  const pieces = useMemo(() => uniquePieces(query.data?.pages ?? []), [query.data]);
  return { pieces, query };
}
