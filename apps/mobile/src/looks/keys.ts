export const LOOK_QUERY_ROOT = 'look';
export const SIMILAR_QUERY_ROOT = 'similar';

/** One look's page data, as the acting profile sees it (`anon` when logged out). */
export function lookQueryKey(profileId: string | null, lookId: string) {
  return [LOOK_QUERY_ROOT, profileId ?? 'anon', lookId] as const;
}

/** "More like this" under a look. */
export function similarQueryKey(profileId: string | null, lookId: string) {
  return [SIMILAR_QUERY_ROOT, profileId ?? 'anon', lookId] as const;
}
