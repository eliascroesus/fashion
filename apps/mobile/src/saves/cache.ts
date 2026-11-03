import type { FeedCard, FeedPage } from '@outfitly/shared';
import type { InfiniteData, QueryClient, QueryKey } from '@tanstack/react-query';
import { CARD_LIST_ROOTS } from './keys';

type Pages = InfiniteData<FeedPage, string | null>;

/** Applies `edit` to every page of the cached lists under `queryKey`, keeping untouched pages as they are. */
function editLists(
  client: QueryClient,
  queryKey: QueryKey,
  edit: (items: FeedCard[]) => FeedCard[],
): void {
  client.setQueriesData<Pages>({ queryKey }, (data) => {
    if (!data) return data;
    const pages = data.pages.map((page) => {
      const items = edit(page.items);
      return items === page.items ? page : { ...page, items };
    });
    return pages.some((page, i) => page !== data.pages[i]) ? { ...data, pages } : data;
  });
}

/** Shows the look as saved (or not) wherever it is cached. */
export function setSavedInLists(client: QueryClient, lookId: string, saved: boolean): void {
  for (const root of CARD_LIST_ROOTS) {
    editLists(client, [root], (items) =>
      items.some((c) => c.id === lookId && c.saved !== saved)
        ? items.map((c) => (c.id === lookId ? { ...c, saved } : c))
        : items,
    );
  }
}

/** Takes the look out of the cached lists under `queryKey` (e.g. Saves after an unsave). */
export function removeFromLists(client: QueryClient, queryKey: QueryKey, lookId: string): void {
  editLists(client, queryKey, (items) =>
    items.some((c) => c.id === lookId) ? items.filter((c) => c.id !== lookId) : items,
  );
}
