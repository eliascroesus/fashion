import { InfiniteQueryObserver, QueryClient } from '@tanstack/react-query';
import { themes } from '@outfitly/ui-tokens';
import { describe, expect, it } from 'vitest';
import { carryOverLoggedOutFeed, findCachedCard, replaceFeed } from './cache';
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
  saved: false,
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

describe('carryOverLoggedOutFeed', () => {
  const me = (profileId: string | null) => ({
    userId: '00000000-0000-4000-8000-000000000001',
    isAnonymous: true,
    activeProfileId: profileId,
    profiles: [],
  });
  const feed = { pages: [{ items: [card('a')], nextCursor: 'x' }], pageParams: [null] };

  it('moves the logged-out For You to the first profile, unchanged', () => {
    const client = new QueryClient();
    client.setQueryData(feedQueryKey('for-you', null), feed, { updatedAt: 1234 });
    carryOverLoggedOutFeed(client, null, me('p1'));
    expect(client.getQueryData(feedQueryKey('for-you', 'p1'))).toBe(feed);
    expect(client.getQueryState(feedQueryKey('for-you', 'p1'))?.dataUpdatedAt).toBe(1234);
  });

  it('leaves profiles that already had a feed, or came from another profile, alone', () => {
    const client = new QueryClient();
    client.setQueryData(feedQueryKey('for-you', null), feed);
    const own = { pages: [], pageParams: [] };
    client.setQueryData(feedQueryKey('for-you', 'p1'), own);
    carryOverLoggedOutFeed(client, null, me('p1'));
    expect(client.getQueryData(feedQueryKey('for-you', 'p1'))).toBe(own);
    carryOverLoggedOutFeed(client, me('p1'), me('p2'));
    expect(client.getQueryData(feedQueryKey('for-you', 'p2'))).toBeUndefined();
  });

  it('gives a sign-in to an existing account its own feed, not the logged-out one', () => {
    const client = new QueryClient();
    client.setQueryData(feedQueryKey('for-you', null), feed);
    carryOverLoggedOutFeed(client, null, { ...me('account'), isAnonymous: false });
    expect(client.getQueryData(feedQueryKey('for-you', 'account'))).toBeUndefined();
  });
});
