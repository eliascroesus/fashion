export const SEARCH_QUERY_ROOT = 'search';
export const SUGGEST_QUERY_ROOT = 'search-suggest';
export const POPULAR_QUERY_ROOT = 'search-popular';

/** One search's results, as the acting profile sees them (`anon` when logged out). */
export function searchQueryKey(profileId: string | null, text: string) {
  return [SEARCH_QUERY_ROOT, profileId ?? 'anon', text] as const;
}

/** Suggestions for what's typed (the same for everyone). */
export function suggestQueryKey(text: string) {
  return [SUGGEST_QUERY_ROOT, text] as const;
}

export const popularQueryKey = [POPULAR_QUERY_ROOT] as const;
