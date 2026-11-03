import type { PersistedClient } from '@tanstack/react-query-persist-client';
import { FEED_QUERY_ROOT } from '../feed/keys';

/** Pages of each feed kept on the phone: enough for a cold start, small enough to write quickly. */
export const STORED_FEED_PAGES = 2;

/**
 * The query cache as stored on the phone: every feed cut to its first pages.
 * The last kept page still carries its cursor, so the restored feed scrolls on.
 */
export function trimFeedsForStorage(
  client: PersistedClient,
  maxPages: number = STORED_FEED_PAGES,
): PersistedClient {
  const queries = client.clientState.queries.map((query) => {
    const data = query.state.data as { pages?: unknown[]; pageParams?: unknown[] } | undefined;
    if (query.queryKey[0] !== FEED_QUERY_ROOT || !data?.pages || !data.pageParams) return query;
    if (data.pages.length <= maxPages) return query;
    return {
      ...query,
      state: {
        ...query.state,
        data: {
          pages: data.pages.slice(0, maxPages),
          pageParams: data.pageParams.slice(0, maxPages),
        },
      },
    };
  });
  return { ...client, clientState: { ...client.clientState, queries } };
}
