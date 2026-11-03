import type { FeedCard, FeedPage } from '@outfitly/shared';
import { themes } from '@outfitly/ui-tokens';
import { describe, expect, it } from 'vitest';
import {
  cardWidth,
  dedupeCards,
  photoHeight,
  photosToPrefetch,
  pickPhotoUrl,
  shouldLoadMore,
} from './layout';

const metrics = { columns: 2, gap: 6, inset: 6 };

function card(n: number, width = 1080, height = 1440): FeedCard {
  const id = `00000000-0000-4000-8000-${String(n).padStart(12, '0')}`;
  return {
    id,
    authorId: id,
    photo: {
      width,
      height,
      thumbhash: 'k0oGLQaSVsN0BVhn2oq2Z5SQUQcZ',
      dominantColor: themes.light.surfaceMuted,
      urls: {
        1080: `https://img.test/${String(n)}/1080.webp`,
        600: `https://img.test/${String(n)}/600.webp`,
        300: `https://img.test/${String(n)}/300.webp`,
      },
    },
    itemCount: 0,
  };
}

const page = (ids: number[], nextCursor: string | null = 'next'): FeedPage => ({
  items: ids.map((n) => card(n)),
  nextCursor,
});

describe('card size', () => {
  it('splits the screen into two columns with gaps and edges', () => {
    // 390 − 2×6 edge − 6 gap = 372 → 186 per column.
    expect(cardWidth(390, metrics)).toBe(186);
  });

  it('keeps the photo shape, cropping very tall or very wide photos', () => {
    expect(photoHeight(card(1, 1080, 1440).photo, 200)).toBe(267); // 3:4
    expect(photoHeight(card(1, 1080, 4320).photo, 200)).toBe(360); // 1:4 → capped at 1.8
    expect(photoHeight(card(1, 1080, 270).photo, 200)).toBe(120); // 4:1 → at least 0.6
  });
});

describe('pickPhotoUrl', () => {
  const urls = card(1).photo.urls;
  it('takes the smallest size that is still sharp', () => {
    expect(pickPhotoUrl(urls, 280)).toBe(urls[300]);
    expect(pickPhotoUrl(urls, 300)).toBe(urls[300]);
    expect(pickPhotoUrl(urls, 558)).toBe(urls[600]); // 186 pt × 3 on an iPhone
    expect(pickPhotoUrl(urls, 700)).toBe(urls[1080]);
  });

  it('falls back to the largest size', () => {
    expect(pickPhotoUrl(urls, 2000)).toBe(urls[1080]);
  });
});

describe('dedupeCards', () => {
  it('joins pages and keeps each look once, in first-seen order', () => {
    const cards = dedupeCards([page([1, 2, 3]), page([3, 4, 1, 5])]);
    expect(cards.map((c) => c.id.slice(-1))).toEqual(['1', '2', '3', '4', '5']);
  });
});

describe('shouldLoadMore', () => {
  it('asks for the next page 60% of the way into the newest page', () => {
    expect(shouldLoadMore(11, 20)).toBe(false);
    expect(shouldLoadMore(12, 20)).toBe(true);
    expect(shouldLoadMore(31, 40)).toBe(false);
    expect(shouldLoadMore(32, 40)).toBe(true);
  });

  it('waits while nothing is on screen or loaded', () => {
    expect(shouldLoadMore(-1, 20)).toBe(false);
    expect(shouldLoadMore(0, 0)).toBe(false);
  });

  it('asks straight away when a short list is all on screen', () => {
    expect(shouldLoadMore(4, 5)).toBe(true);
  });
});

describe('photosToPrefetch', () => {
  const cards = Array.from({ length: 40 }, (_, i) => card(i));
  const base = {
    cards,
    viewportHeight: 800,
    cardWidth: 186,
    widthPx: 558,
    metrics,
    done: new Set<string>(),
  };

  it('fetches two screens of photos below the furthest visible card', () => {
    // Each 3:4 card is 248 + 6 gap = 254 tall; two columns × two screens of 800 = 3200 → 13 cards.
    const urls = photosToPrefetch({ ...base, furthestVisible: 5 });
    expect(urls).toHaveLength(13);
    expect(urls[0]).toBe('https://img.test/6/600.webp');
  });

  it('skips photos it already asked for, and stops at the end of the list', () => {
    const done = new Set(['https://img.test/6/600.webp']);
    expect(photosToPrefetch({ ...base, furthestVisible: 5, done })[0]).toBe(
      'https://img.test/7/600.webp',
    );
    expect(photosToPrefetch({ ...base, furthestVisible: 37 })).toEqual([
      'https://img.test/38/600.webp',
      'https://img.test/39/600.webp',
    ]);
  });
});
