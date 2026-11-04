import type { FeedPage } from '@outfitly/shared';
import { type InfiniteData, InfiniteQueryObserver, QueryClient } from '@tanstack/react-query';
import { themes } from '@outfitly/ui-tokens';
import { describe, expect, it } from 'vitest';
import { lookQueryKey, similarQueryKey } from '../looks/keys';
import { removeFromLists, setSavedInLists } from '../saves/cache';
import {
  carryOverLoggedOutData,
  findCachedCard,
  listIdentity,
  replaceFeed,
  startList,
} from './cache';
import { FEED_QUERY_ROOT, feedQueryKey } from './keys';

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

describe('carryOverLoggedOutData', () => {
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
    carryOverLoggedOutData(client, null, me('p1'));
    expect(client.getQueryData(feedQueryKey('for-you', 'p1'))).toBe(feed);
    expect(client.getQueryState(feedQueryKey('for-you', 'p1'))?.dataUpdatedAt).toBe(1234);
  });

  it('leaves profiles that already had a feed, or came from another profile, alone', () => {
    const client = new QueryClient();
    client.setQueryData(feedQueryKey('for-you', null), feed);
    const own = { pages: [], pageParams: [] };
    client.setQueryData(feedQueryKey('for-you', 'p1'), own);
    carryOverLoggedOutData(client, null, me('p1'));
    expect(client.getQueryData(feedQueryKey('for-you', 'p1'))).toBe(own);
    carryOverLoggedOutData(client, me('p1'), me('p2'));
    expect(client.getQueryData(feedQueryKey('for-you', 'p2'))).toBeUndefined();
  });

  it('gives a sign-in to an existing account its own feed, not the logged-out one', () => {
    const client = new QueryClient();
    client.setQueryData(feedQueryKey('for-you', null), feed);
    carryOverLoggedOutData(client, null, { ...me('account'), isAnonymous: false });
    expect(client.getQueryData(feedQueryKey('for-you', 'account'))).toBeUndefined();
  });

  it('keeps an open look page and its "More like this" through the first save', () => {
    const client = new QueryClient();
    const detail = { id: 'look-1' };
    client.setQueryData(lookQueryKey(null, 'look-1'), detail, { updatedAt: 99 });
    client.setQueryData(similarQueryKey(null, 'look-1'), feed);
    carryOverLoggedOutData(client, null, me('guest'));
    expect(client.getQueryData(lookQueryKey('guest', 'look-1'))).toBe(detail);
    expect(client.getQueryState(lookQueryKey('guest', 'look-1'))?.dataUpdatedAt).toBe(99);
    expect(client.getQueryData(similarQueryKey('guest', 'look-1'))).toBe(feed);
  });
});

describe('listIdentity', () => {
  const key = feedQueryKey('for-you', 'p');
  const firstPage = (client: QueryClient) =>
    client.getQueryData<InfiniteData<FeedPage, string | null>>(key)?.pages[0];
  const withList = (client: QueryClient) => {
    client.setQueryData(key, {
      pages: [
        startList({ items: [card('a'), card('b')], nextCursor: 'x' }),
        { items: [card('c')], nextCursor: null },
      ],
      pageParams: [null, 'x'],
    });
    return listIdentity(firstPage(client));
  };

  it('stays the same when a look on the first page is saved (the grid keeps its place)', () => {
    const client = new QueryClient();
    const before = withList(client);
    const page = firstPage(client);
    setSavedInLists(client, 'b', true);
    expect(firstPage(client)).not.toBe(page);
    expect(listIdentity(firstPage(client))).toBe(before);
  });

  it('stays the same when a look on the first page is hidden ("see less")', () => {
    const client = new QueryClient();
    const before = withList(client);
    removeFromLists(client, [FEED_QUERY_ROOT], 'a');
    expect(firstPage(client)?.items.map((c) => c.id)).toEqual(['b']);
    expect(listIdentity(firstPage(client))).toBe(before);
  });

  it('changes for a new list, even one with the same looks', async () => {
    const client = new QueryClient();
    const before = withList(client);
    await replaceFeed(client, key, startList({ items: [card('a'), card('b')], nextCursor: 'x' }));
    expect(listIdentity(firstPage(client))).toBeDefined();
    expect(listIdentity(firstPage(client))).not.toBe(before);
  });

  it('survives being stored on the phone (JSON)', () => {
    const page = startList({ items: [card('a')], nextCursor: null });
    const stored = JSON.parse(JSON.stringify(page)) as FeedPage;
    expect(listIdentity(stored)).toBe(listIdentity(page));
  });

  it('is undefined before the first page arrives', () => {
    expect(listIdentity(undefined)).toBeUndefined();
  });
});
