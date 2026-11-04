export const PROFILE_QUERY_ROOT = 'profile';
export const PROFILE_LOOKS_QUERY_ROOT = 'profile-looks';

/** The top of a profile screen, as the acting profile sees it (`anon` when logged out). */
export function profileQueryKey(viewerId: string | null, profileId: string) {
  return [PROFILE_QUERY_ROOT, viewerId ?? 'anon', profileId] as const;
}

/** A profile's looks. */
export function profileLooksQueryKey(viewerId: string | null, profileId: string) {
  return [PROFILE_LOOKS_QUERY_ROOT, viewerId ?? 'anon', profileId] as const;
}
