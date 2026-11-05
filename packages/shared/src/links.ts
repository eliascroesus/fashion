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
    /** The shop's photo; our copy (`image`) follows within seconds. */
    imageUrl: z.string().nullable(),
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
