import type { SimilarPieceSort } from '@outfitly/shared';

export const LOOK_QUERY_ROOT = 'look';
export const SIMILAR_QUERY_ROOT = 'similar';
export const SIMILAR_PIECES_QUERY_ROOT = 'similar-pieces';

/** One look's page data, as the acting profile sees it (`anon` when logged out). */
export function lookQueryKey(profileId: string | null, lookId: string) {
  return [LOOK_QUERY_ROOT, profileId ?? 'anon', lookId] as const;
}

/** "More like this" under a look. */
export function similarQueryKey(profileId: string | null, lookId: string) {
  return [SIMILAR_QUERY_ROOT, profileId ?? 'anon', lookId] as const;
}

/** "Similar pieces" for one piece of a look, in one sort (the same for everyone). */
export function similarPiecesQueryKey(itemId: string, sort: SimilarPieceSort) {
  return [SIMILAR_PIECES_QUERY_ROOT, itemId, sort] as const;
}
