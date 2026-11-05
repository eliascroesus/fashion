import { z } from 'zod';
import { GARMENT_CATEGORIES } from './products.ts';

/** Longest link we keep (`offers.url` / `offers.page_url`, migration 0011). */
export const MAX_LINK_BYTES = 2048;

/**
 * `POST /v1/links/resolve`: a shop link as pasted (or shared text containing
 * one). The first http(s) link in it is used; a bare `www.shop.se/…` gets https.
 */
export const resolveLinkBodySchema = z.object({
  url: z.string().trim().min(1).max(4096),
});
export type ResolveLinkBody = z.infer<typeof resolveLinkBodySchema>;

export const OFFER_STOCK = ['in_stock', 'out_of_stock', 'unknown'] as const;
export type OfferStock = (typeof OFFER_STOCK)[number];

/**
 * Why a link gave no product. The app shows a message per reason; `blocked`
 * means the shop turned our reader away (bot protection), not that the link
 * is wrong.
 */
/**
 * `details` of a `link_unreadable` error: the problem, whether it may go away
 * (a slow, down or busy shop: the same request with the same key reads again),
 * and the shop's HTTP status when it answered.
 */
export interface LinkUnreadableDetails {
  problem: LinkProblem;
  temporary: boolean;
  shopStatus?: number;
}

export const LINK_PROBLEMS = [
  /** Not a web link we can open (bad format, not http(s), odd port, user:password@). */
  'bad_link',
  /** The link leads to a private or internal address. */
  'forbidden',
  'not_found',
  'blocked',
  'unreachable',
  'too_slow',
  'too_many_redirects',
  /** The page isn't HTML (a PDF, an image…). */
  'not_a_page',
  /** The page has no product data we can read. */
  'no_product',
] as const;
export type LinkProblem = (typeof LINK_PROBLEMS)[number];

const mediaUrlsSchema = z.object({ 1080: z.url(), 600: z.url(), 300: z.url() });

export const resolvedLinkSchema = z.object({
  /**
   * `created`: new offer. `updated`: read again just now. `recent`: read less
   * than an hour ago, answered from our database without asking the shop.
   */
  outcome: z.enum(['created', 'updated', 'recent']),
  product: z.object({
    id: z.uuid(),
    name: z.string(),
    brand: z.string().nullable(),
    category: z.enum(GARMENT_CATEGORIES).nullable(),
    gtin: z.string().nullable(),
    /** Our copy of the shop's photo: null for the few seconds until it's copied in. */
    image: z
      .object({
        width: z.number().int(),
        height: z.number().int(),
        thumbhash: z.string(),
        dominantColor: z.string(),
        urls: mediaUrlsSchema,
      })
      .nullable(),
  }),
  offer: z.object({
    id: z.uuid(),
    /** The link as posted, affiliate tags kept: Shop opens this one. */
    url: z.string(),
    /** The shop's own product page: price and stock checks read this one. */
    pageUrl: z.string(),
    priceMinor: z.number().int().nullable(),
    currency: z.string().nullable(),
    stock: z.enum(OFFER_STOCK),
    lastCheckedAt: z.iso.datetime().nullable(),
  }),
});
export type ResolvedLink = z.infer<typeof resolvedLinkSchema>;

/**
 * Why the automatic link check (Step 3.5) didn't verify a look item: stored
 * in `link_checks.reason` (the database refuses other values), and the app
 * shows the poster a message per reason (`linkCheck.*` in the app's
 * translations). Adding one needs a migration for that check too.
 * - rejected: `sold_out`, `not_similar` (the photos clearly differ),
 *   `ai_different` (the AI looked and said it's another piece), `link_removed`.
 * - review (a person decides): `ai_unsure` (the AI wasn't sure, or couldn't
 *   answer twice), `no_product_photo` (the shop gave no usable photo),
 *   `no_garment` (the AI found no piece in the look's photos),
 *   `dot_not_on_piece` (the poster's dot isn't on any piece the AI found),
 *   `check_failed` (something needed never came: a fingerprint, the AI).
 */
export const LINK_CHECK_REASONS = [
  'sold_out',
  'not_similar',
  'ai_different',
  'link_removed',
  'ai_unsure',
  'no_product_photo',
  'no_garment',
  'dot_not_on_piece',
  'check_failed',
] as const;
export type LinkCheckReason = (typeof LINK_CHECK_REASONS)[number];
