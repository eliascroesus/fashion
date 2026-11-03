export type FeedKind = 'for-you' | 'following';

export const FEED_QUERY_ROOT = 'feed';

/** One cached feed per kind and acting profile (`anon` when logged out). */
export function feedQueryKey(kind: FeedKind, profileId: string | null) {
  return [FEED_QUERY_ROOT, kind, profileId ?? 'anon'] as const;
}
