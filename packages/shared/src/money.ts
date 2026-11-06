import { z } from 'zod';
import type { OfferStock } from './links.ts';

/**
 * Prices are whole numbers of a currency's smallest unit (öre, cents), never
 * floating point. Most currencies have 2 decimals; these have 0 or 3 (as
 * Node's ICU formats them, which is how Step 3.4 stores shop prices). One
 * table for the API and the app, so a price is read back with the same
 * decimals it was stored with whatever Intl data a phone has.
 */
const ZERO_DECIMALS = new Set([
  'AFN',
  'ALL',
  'BIF',
  'CLP',
  'COP',
  'DJF',
  'GNF',
  'HUF',
  'IDR',
  'IQD',
  'IRR',
  'ISK',
  'JPY',
  'KMF',
  'KPW',
  'KRW',
  'LAK',
  'LBP',
  'MGA',
  'MMK',
  'PKR',
  'PYG',
  'RWF',
  'SLL',
  'SOS',
  'SYP',
  'UGX',
  'VND',
  'VUV',
  'XAF',
  'XOF',
  'XPF',
  'YER',
]);
const THREE_DECIMALS = new Set(['BHD', 'JOD', 'KWD', 'LYD', 'OMR', 'TND']);

export const CURRENCY_CODE = /^[A-Z]{3}$/;

/** Decimals of a currency's smallest unit (2 for SEK, 0 for ISK), or null if it isn't a code. */
export function currencyDigits(currency: string): number | null {
  if (!CURRENCY_CODE.test(currency)) return null;
  if (ZERO_DECIMALS.has(currency)) return 0;
  if (THREE_DECIMALS.has(currency)) return 3;
  return 2;
}

/** An amount in one currency, in its smallest unit. */
export const moneySchema = z.object({
  amountMinor: z.number().int().nonnegative(),
  currency: z.string().regex(CURRENCY_CODE),
});
export type Money = z.infer<typeof moneySchema>;

/**
 * Adds amounts up per currency, in the order each currency first appears.
 * Different currencies are never added together (no exchange rates): a look
 * with SEK and EUR pieces has two totals.
 */
export function sumByCurrency(amounts: readonly Money[]): Money[] {
  const totals = new Map<string, number>();
  for (const { amountMinor, currency } of amounts) {
    const sum = (totals.get(currency) ?? 0) + amountMinor;
    if (!Number.isSafeInteger(sum)) throw new RangeError(`Total too large in ${currency}.`);
    totals.set(currency, sum);
  }
  return [...totals].map(([currency, amountMinor]) => ({ amountMinor, currency }));
}

/** A piece of a look as totals see it. */
export interface PricedPiece {
  id: string;
  price: Money | null;
  stock: OfferStock;
}

/**
 * Whether a piece counts towards a total: it has a price and isn't sold out
 * (unknown stock counts: the shop didn't say it's gone).
 */
export function countsTowardsTotal(piece: PricedPiece): boolean {
  return piece.price !== null && piece.stock !== 'out_of_stock';
}

export interface PiecesTotal {
  /** One per currency; empty when nothing counted. */
  totals: Money[];
  /** Pieces added up. */
  counted: number;
  /** Pieces left out because they're sold out (whether or not they have a price). */
  soldOut: number;
  /** Pieces left out because the shop gave no price (and they aren't sold out). */
  unpriced: number;
}

/**
 * What the pieces cost together: every piece, or only the `selected` ids
 * (the ticks on the look page). Sold-out and unpriced pieces are left out
 * and counted, so the screen can say so.
 */
export function piecesTotal(
  pieces: readonly PricedPiece[],
  selected?: ReadonlySet<string>,
): PiecesTotal {
  const chosen = selected ? pieces.filter((p) => selected.has(p.id)) : pieces;
  const counted = chosen.filter(countsTowardsTotal);
  return {
    totals: sumByCurrency(counted.flatMap((p) => p.price ?? [])),
    counted: counted.length,
    soldOut: chosen.filter((p) => p.stock === 'out_of_stock').length,
    unpriced: chosen.filter((p) => p.price === null && p.stock !== 'out_of_stock').length,
  };
}

const formatters = new Map<string, Intl.NumberFormat>();

function formatter(locale: string, currency: string, decimals: number): Intl.NumberFormat {
  const key = `${locale}|${currency}|${String(decimals)}`;
  let format = formatters.get(key);
  if (!format) {
    format = new Intl.NumberFormat(locale, {
      style: 'currency',
      currency,
      minimumFractionDigits: decimals,
      maximumFractionDigits: decimals,
    });
    formatters.set(key, format);
  }
  return format;
}

/**
 * An amount as people write it in `locale` ("1 299 kr", "399,50 kr",
 * "€45"): decimals only when it isn't a whole amount. Falls back to
 * "1299.00 SEK" if the phone can't format that currency.
 */
export function formatMoney({ amountMinor, currency }: Money, locale: string): string {
  const digits = currencyDigits(currency) ?? 2;
  const unit = 10 ** digits;
  const decimals = amountMinor % unit === 0 ? 0 : digits;
  const value = amountMinor / unit;
  try {
    return formatter(locale, currency, decimals).format(value);
  } catch {
    return `${value.toFixed(decimals)} ${currency}`;
  }
}

/** Totals in several currencies side by side: "1 299 kr + 45 €". */
export function formatTotals(totals: readonly Money[], locale: string): string {
  return totals.map((money) => formatMoney(money, locale)).join(' + ');
}
