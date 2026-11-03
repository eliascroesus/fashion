import type { FeedCard, FeedPage } from '@outfitly/shared';
import { themes } from '@outfitly/ui-tokens';
import { type InfiniteData, QueryClient } from '@tanstack/react-query';
import { describe, expect, it } from 'vitest';
import { feedQueryKey } from '../feed/keys';
import { removeFromLists, setSavedInLists } from './cache';
import { boardLooksQueryKey, boardsQueryKey, savesQueryKey } from './keys';

const card = (id: string, saved = false): FeedCard => ({
  id,
  authorId: 'author',
  photo: {
    width: 3,
    height: 4,
    thumbhash: 'x',
    dominantColor: themes.light.surfaceMuted,
    urls: { 1080: 'https://a/1', 600: 'https://a/6', 300: 'https://a/3' },
  },
  itemCount: 0,
  saved,
});

const list = (...pages: FeedCard[][]): InfiniteData<FeedPage, string | null> => ({
  pages: pages.map((items, i) => ({
    items,
    nextCursor: i < pages.length - 1 ? `c${String(i)}` : null,
  })),
  pageParams: pages.map((_, i) => (i === 0 ? null : `c${String(i - 1)}`)),
});

const ids = (client: QueryClient, key: readonly unknown[]) =>
  client
    .getQueryData<InfiniteData<FeedPage>>(key)
    ?.pages.map((p) => p.items.map((c) => `${c.id}${c.saved ? '*' : ''}`));

describe('saved-look cache helpers', () => {
  it('marks a look saved in every cached feed, Saves and board list', () => {
    const client = new QueryClient();
    client.setQueryData(feedQueryKey('for-you', 'p'), list([card('a'), card('b')], [card('c')]));
    client.setQueryData(feedQueryKey('following', 'p'), list([card('c')]));
    client.setQueryData(boardLooksQueryKey('p', 'board'), list([card('c')]));
    client.setQueryData(boardsQueryKey('p'), { items: [] });

    setSavedInLists(client, 'c', true);
    expect(ids(client, feedQueryKey('for-you', 'p'))).toEqual([['a', 'b'], ['c*']]);
    expect(ids(client, feedQueryKey('following', 'p'))).toEqual([['c*']]);
    expect(ids(client, boardLooksQueryKey('p', 'board'))).toEqual([['c*']]);
    expect(client.getQueryData(boardsQueryKey('p'))).toEqual({ items: [] });

    // Already unsaved, or not cached at all: the cached lists stay the same objects.
    const forYou = client.getQueryData(feedQueryKey('for-you', 'p'));
    setSavedInLists(client, 'b', false);
    setSavedInLists(client, 'zzz', true);
    expect(client.getQueryData(feedQueryKey('for-you', 'p'))).toBe(forYou);
  });

  it('removes a look from the lists under a key', () => {
    const client = new QueryClient();
    client.setQueryData(
      savesQueryKey('p'),
      list([card('a', true), card('b', true)], [card('c', true)]),
    );
    removeFromLists(client, savesQueryKey('p'), 'b');
    expect(ids(client, savesQueryKey('p'))).toEqual([['a*'], ['c*']]);
    removeFromLists(client, savesQueryKey('other'), 'a'); // not loaded: nothing happens
    expect(client.getQueryData(savesQueryKey('other'))).toBeUndefined();
  });
});
