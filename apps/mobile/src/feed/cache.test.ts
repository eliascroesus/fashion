import { QueryClient } from '@tanstack/react-query';
import { themes } from '@outfitly/ui-tokens';
import { describe, expect, it } from 'vitest';
import { findCachedCard } from './cache';
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
