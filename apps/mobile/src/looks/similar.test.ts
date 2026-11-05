import type { SimilarPiece } from '@outfitly/shared';
import { themes } from '@outfitly/ui-tokens';
import { describe, expect, it } from 'vitest';
import { uniquePieces } from './similar';

const piece = (productId: string): SimilarPiece => ({
  offerId: crypto.randomUUID(),
  productId,
  lookId: crypto.randomUUID(),
  brand: 'Acme',
  name: 'Coat',
  category: 'coat',
  image: {
    width: 800,
    height: 1000,
    thumbhash: 'k0oGLQaSVsN0BVhn2oq2Z5SQUQcZ',
    dominantColor: themes.light.surfaceMuted,
    urls: {
      1080: 'https://img.test/1080',
      600: 'https://img.test/600',
      300: 'https://img.test/300',
    },
  },
  price: { amountMinor: 99900, currency: 'SEK' },
  stock: 'in_stock',
  priceCheckedAt: null,
  url: 'https://shop.test/p?aff=x',
  shop: 'shop.test',
});

describe('uniquePieces', () => {
  it('keeps the order of the pages and shows each product once', () => {
    const [a, b, c] = [piece('a'), piece('b'), piece('c')];
    const again = piece('b');
    const pages = [
      { items: [a, b], nextCursor: 'x' },
      { items: [again, c], nextCursor: null },
    ];
    expect(uniquePieces(pages)).toEqual([a, b, c]);
    expect(uniquePieces([])).toEqual([]);
  });
});
