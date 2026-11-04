import { useQuery } from '@tanstack/react-query';
import { api } from '../api';
import { useMe } from '../auth/store';
import { type CardList, usePagedCards } from '../feed/card-list';
import { profileLooksQueryKey, profileQueryKey } from './keys';

/** The top of a profile screen (counts, whether the acting profile follows it). */
export function useProfile(profileId: string | null) {
  const viewerId = useMe()?.activeProfileId ?? null;
  return useQuery({
    queryKey: profileQueryKey(viewerId, profileId ?? ''),
    queryFn: ({ signal }) => api.profiles.get(profileId ?? '', signal),
    enabled: profileId !== null,
  });
}

/** A profile's looks, newest first, 20 at a time. */
export function useProfileLooks(profileId: string | null): CardList {
  const viewerId = useMe()?.activeProfileId ?? null;
  return usePagedCards(
    profileLooksQueryKey(viewerId, profileId ?? ''),
    (cursor, signal) => api.profiles.looks(profileId ?? '', cursor, signal),
    profileId !== null,
  );
}
