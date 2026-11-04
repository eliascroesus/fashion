import { FEED_QUERY_ROOT } from '../feed/keys';
import { SIMILAR_QUERY_ROOT } from '../looks/keys';
import { PROFILE_LOOKS_QUERY_ROOT } from '../profiles/keys';
import { SEARCH_QUERY_ROOT } from '../search/keys';

export const SAVES_QUERY_ROOT = 'saves';
export const BOARDS_QUERY_ROOT = 'boards';
export const BOARD_LOOKS_QUERY_ROOT = 'board-looks';

/**
 * Cached lists of look cards (pages with cursors): home feeds, Saves, boards,
 * "more like this", search results and profiles' looks.
 */
export const CARD_LIST_ROOTS: readonly string[] = [
  FEED_QUERY_ROOT,
  SAVES_QUERY_ROOT,
  BOARD_LOOKS_QUERY_ROOT,
  SIMILAR_QUERY_ROOT,
  SEARCH_QUERY_ROOT,
  PROFILE_LOOKS_QUERY_ROOT,
];

/** Everything the profile saved, newest first. */
export function savesQueryKey(profileId: string | null) {
  return [SAVES_QUERY_ROOT, profileId ?? 'anon'] as const;
}

/** The profile's boards; with `lookId`, also which hold that look (the board picker). */
export function boardsQueryKey(profileId: string | null, lookId?: string) {
  return lookId
    ? ([BOARDS_QUERY_ROOT, profileId ?? 'anon', lookId] as const)
    : ([BOARDS_QUERY_ROOT, profileId ?? 'anon'] as const);
}

export function boardLooksQueryKey(profileId: string | null, boardId: string) {
  return [BOARD_LOOKS_QUERY_ROOT, profileId ?? 'anon', boardId] as const;
}
