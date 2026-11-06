import { describe, expect, it } from 'vitest';
import {
  countsTowardsTotal,
  currencyDigits,
  formatMoney,
  formatTotals,
  type Money,
  moneySchema,
  type PricedPiece,
  piecesTotal,
  sumByCurrency,
} from './money.ts';

const sek = (amountMinor: number): Money => ({ amountMinor, currency: 'SEK' });
const eur = (amountMinor: number): Money => ({ amountMinor, currency: 'EUR' });

function piece(id: string, price: Money | null, stock: PricedPiece['stock'] = 'in_stock') {
  return { id, price, stock };
}

/** Intl writes non-breaking and narrow spaces; compare with plain ones. */
const plain = (text: string) => text.replace(/[\u00a0\u202f]/g, ' ');

describe('currencyDigits', () => {
  it.each([
    ['SEK', 2],
    ['NOK', 2],
    ['DKK', 2],
    ['EUR', 2],
    ['GBP', 2],
    ['USD', 2],
    ['ISK', 0],
    ['JPY', 0],
    ['KWD', 3],
  ])('%s has %i decimals', (currency, digits) => {
    expect(currencyDigits(currency)).toBe(digits);
  });

  it.each(['sek', 'SEKK', 'SE', '', '12A'])('%j is not a currency code', (currency) => {
    expect(currencyDigits(currency)).toBeNull();
  });
});

describe('moneySchema', () => {
  it('takes whole, non-negative amounts with a currency code', () => {
    expect(moneySchema.safeParse(sek(129900)).success).toBe(true);
    expect(moneySchema.safeParse(sek(0)).success).toBe(true);
    expect(moneySchema.safeParse(sek(12.5)).success).toBe(false);
    expect(moneySchema.safeParse(sek(-1)).success).toBe(false);
    expect(moneySchema.safeParse({ amountMinor: 100, currency: 'kr' }).success).toBe(false);
  });
});

describe('sumByCurrency', () => {
  it('adds one currency up exactly, in whole minor units', () => {
    expect(sumByCurrency([sek(129900), sek(39950), sek(50)])).toEqual([sek(169900)]);
    // 0.10 + 0.20 kr is 0.30 kr exactly (no floating point).
    expect(sumByCurrency([sek(10), sek(20)])).toEqual([sek(30)]);
    expect(sumByCurrency([sek(33333), sek(33333), sek(33333)])).toEqual([sek(99999)]);
  });

  it('never adds different currencies together, in order of first appearance', () => {
    expect(sumByCurrency([eur(4500), sek(129900), eur(1999), sek(100)])).toEqual([
      eur(6499),
      sek(130000),
    ]);
  });

  it('is empty for nothing, and keeps zero amounts', () => {
    expect(sumByCurrency([])).toEqual([]);
    expect(sumByCurrency([sek(0)])).toEqual([sek(0)]);
  });

  it('refuses a total too large to count exactly', () => {
    expect(() => sumByCurrency([sek(Number.MAX_SAFE_INTEGER), sek(1)])).toThrow(RangeError);
  });
});

describe('countsTowardsTotal', () => {
  it('counts priced pieces that are in stock or of unknown stock', () => {
    expect(countsTowardsTotal(piece('a', sek(100)))).toBe(true);
    expect(countsTowardsTotal(piece('a', sek(100), 'unknown'))).toBe(true);
    expect(countsTowardsTotal(piece('a', sek(100), 'out_of_stock'))).toBe(false);
    expect(countsTowardsTotal(piece('a', null))).toBe(false);
  });
});

describe('piecesTotal', () => {
  const look = [
    piece('coat', sek(129900)),
    piece('jeans', sek(59900)),
    piece('bag', sek(89900), 'out_of_stock'),
    piece('shoes', null),
    piece('scarf', sek(19950), 'unknown'),
  ];

  it('adds up every piece that counts and says what was left out', () => {
    expect(piecesTotal(look)).toEqual({
      totals: [sek(209750)],
      counted: 3,
      soldOut: 1,
      unpriced: 1,
    });
  });

  it('adds up only the ticked pieces', () => {
    expect(piecesTotal(look, new Set(['coat', 'scarf']))).toEqual({
      totals: [sek(149850)],
      counted: 2,
      soldOut: 0,
      unpriced: 0,
    });
  });

  it('leaves a ticked sold-out or unpriced piece out of the total, and says so', () => {
    expect(piecesTotal(look, new Set(['jeans', 'bag', 'shoes']))).toEqual({
      totals: [sek(59900)],
      counted: 1,
      soldOut: 1,
      unpriced: 1,
    });
  });

  it('is empty with nothing ticked, and ignores ticks of pieces not in the look', () => {
    expect(piecesTotal(look, new Set())).toEqual({
      totals: [],
      counted: 0,
      soldOut: 0,
      unpriced: 0,
    });
    expect(piecesTotal(look, new Set(['gone', 'jeans'])).totals).toEqual([sek(59900)]);
  });

  it('keeps one total per currency for a mixed look', () => {
    const mixed = [piece('a', sek(129900)), piece('b', eur(4500)), piece('c', sek(100))];
    expect(piecesTotal(mixed).totals).toEqual([sek(130000), eur(4500)]);
  });

  it('counts a sold-out piece without a price as sold out only', () => {
    expect(piecesTotal([piece('a', null, 'out_of_stock')])).toEqual({
      totals: [],
      counted: 0,
      soldOut: 1,
      unpriced: 0,
    });
  });
});

describe('formatMoney', () => {
  it('writes whole amounts without decimals and others with them', () => {
    expect(plain(formatMoney(sek(129900), 'sv-SE'))).toBe('1 299 kr');
    expect(plain(formatMoney(sek(39950), 'sv-SE'))).toBe('399,50 kr');
    expect(plain(formatMoney(sek(5), 'sv-SE'))).toBe('0,05 kr');
    expect(plain(formatMoney(eur(4500), 'en-GB'))).toBe('€45');
    expect(plain(formatMoney(eur(1999), 'en-GB'))).toBe('€19.99');
  });

  it('reads the amount with the currency’s own decimals', () => {
    // ISK has no decimals: 12990 is 12 990 crowns, not 129,90.
    expect(plain(formatMoney({ amountMinor: 12990, currency: 'ISK' }, 'sv-SE'))).toMatch(
      /^12 990 \S+$/,
    );
    // KWD has three: 1500 is 1.500 dinars.
    expect(plain(formatMoney({ amountMinor: 1500, currency: 'KWD' }, 'en-GB'))).toMatch(/1\.500/);
  });

  it('tells Nordic crowns apart', () => {
    expect(plain(formatMoney({ amountMinor: 129900, currency: 'NOK' }, 'sv-SE'))).toBe('1 299 Nkr');
  });

  it('falls back to the plain number and code when the locale can’t be used', () => {
    expect(formatMoney(sek(129900), 'not a locale!')).toBe('1299 SEK');
    expect(formatMoney(sek(39950), 'not a locale!')).toBe('399.50 SEK');
  });
});

describe('formatTotals', () => {
  it('joins the totals of several currencies', () => {
    expect(plain(formatTotals([sek(129900), eur(4500)], 'sv-SE'))).toBe('1 299 kr + 45 €');
    expect(formatTotals([], 'sv-SE')).toBe('');
  });
});
