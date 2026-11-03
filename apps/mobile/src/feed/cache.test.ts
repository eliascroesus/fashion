import { InfiniteQueryObserver, QueryClient } from '@tanstack/react-query';
import { themes } from '@outfitly/ui-tokens';
import { describe, expect, it } from 'vitest';
import { findCachedCard, replaceFeed } from './cache';
import { feedQueryKey } from './keys';

const card = (id: string) => ({
  id,
  authorId: id,
  photo: {
    width: 3,
    height: 4,
    thumbhash: 'x',
    dominantColor: themes.light.surfaceMuted,
    urls: { 1080: 'https://a/1', 600: 'https://a/6', 300: 'https://a/3' },
  },
  itemCount: 0,
});

describe('findCachedCard', () => {
  it('finds a look in any cached feed page', () => {
    const client = new QueryClient();
    client.setQueryData(feedQueryKey('for-you', null), {
      pages: [
        { items: [card('a')], nextCursor: 'x' },
        { items: [card('b')], nextCursor: null },
      ],
      pageParams: [null, 'x'],
    });
    client.setQueryData(feedQueryKey('following', 'p'), {
      pages: [{ items: [card('c')], nextCursor: null }],
      pageParams: [null],
    });
    expect(findCachedCard(client, 'b')?.id).toBe('b');
    expect(findCachedCard(client, 'c')?.id).toBe('c');
    expect(findCachedCard(client, 'zzz')).toBeUndefined();
  });
});

describe('replaceFeed', () => {
  it('drops a next page of the old list that is still loading', async () => {
    const client = new QueryClient();
    const key = feedQueryKey('for-you', null);
    const page = (id: string, nextCursor: string | null) => ({ items: [card(id)], nextCursor });
    let finishOldPage: (p: ReturnType<typeof page>) => void = () => undefined;
    const observer = new InfiniteQueryObserver(client, {
      queryKey: key,
      queryFn: ({ pageParam }: { pageParam: string | null }) =>
        pageParam === null
          ? Promise.resolve(page('old-1', 'old-cursor'))
          : new Promise<ReturnType<typeof page>>((resolve) => {
              finishOldPage = resolve;
            }),
      initialPageParam: null as string | null,
      getNextPageParam: (last: ReturnType<typeof page>) => last.nextCursor,
    });
    const unsubscribe = observer.subscribe(() => undefined);
    await observer.refetch();
    const loading = observer.fetchNextPage();

    await replaceFeed(client, key, page('new-1', 'new-cursor'));
    finishOldPage(page('old-2', null));
    await loading;

    const data = client.getQueryData<{ pages: { items: { id: string }[] }[] }>(key);
    expect(data?.pages.map((p) => p.items[0]?.id)).toEqual(['new-1']);
    expect(observer.getCurrentResult().hasNextPage).toBe(true);
    unsubscribe();
  });
});
