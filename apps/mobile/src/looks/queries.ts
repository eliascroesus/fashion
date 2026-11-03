import { useQuery } from '@tanstack/react-query';
import { api } from '../api';
import { useMe } from '../auth/store';
import { type CardList, usePagedCards } from '../feed/card-list';
import { lookQueryKey, similarQueryKey } from './keys';

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
