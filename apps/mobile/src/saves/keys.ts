import { FEED_QUERY_ROOT } from '../feed/keys';

export const SAVES_QUERY_ROOT = 'saves';
export const BOARDS_QUERY_ROOT = 'boards';
export const BOARD_LOOKS_QUERY_ROOT = 'board-looks';

/** Cached lists of look cards (pages with cursors): the home feeds, Saves and boards' looks. */
export const CARD_LIST_ROOTS: readonly string[] = [
  FEED_QUERY_ROOT,
  SAVES_QUERY_ROOT,
  BOARD_LOOKS_QUERY_ROOT,
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
