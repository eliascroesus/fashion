import { z } from 'zod';
import { feedCardSchema } from './feed.ts';
import { OFFER_STOCK } from './links.ts';
import { MAX_LOOK_PHOTOS } from './looks.ts';
import { moneySchema } from './money.ts';
import { GARMENT_CATEGORIES } from './products.ts';

/**
 * "More like this" under a look goes on for at most this many looks (20
 * pages, like a For You list).
 */
export const MAX_SIMILAR_LOOKS = 400;

const photoSchema = feedCardSchema.shape.photo;

/** Who posted a look, as the viewer sees them. */
export const lookAuthorSchema = z.object({
  id: z.uuid(),
  handle: z.string(),
  displayName: z.string().nullable(),
  /** Their profile photo; null shows their first letter. */
  avatar: photoSchema.nullable(),
  isVerified: z.boolean(),
  /** Whether the viewer follows them (false when logged out). */
  isFollowing: z.boolean(),
});
export type LookAuthor = z.infer<typeof lookAuthorSchema>;

/** A look shows at most this many pieces. */
export const MAX_LOOK_ITEMS = 30;

/**
 * One piece of a look ("shop the look"): a checked shop link and its
 * product. Only links the check verified are shown (Step 3.5).
 */
export const lookItemSchema = z.object({
  /** The look item. */
  id: z.uuid(),
  offerId: z.uuid(),
  productId: z.uuid(),
  brand: z.string().nullable(),
  name: z.string(),
  category: z.enum(GARMENT_CATEGORIES).nullable(),
  /** Our copy of the shop's photo; null until it's copied in (or if the shop gave none). */
  image: photoSchema.nullable(),
  /** Null when the shop gave no price. */
  price: moneySchema.nullable(),
  stock: z.enum(OFFER_STOCK),
  /** When the shop's page was last read (the price's age). */
  priceCheckedAt: z.iso.datetime().nullable(),
  /** The link as posted, affiliate tags kept: Shop opens this (Step 3.7). */
  url: z.string(),
  /** The shop's site, e.g. "zalando.se". */
  shop: z.string(),
  /**
   * Where the piece is: on photo `photo` (index into `photos`), in fractions
   * of that photo. The poster's dot, else the middle of the piece the AI
   * found; null if neither is known.
   */
  dot: z
    .object({
      photo: z.number().int().nonnegative(),
      x: z.number().min(0).max(1),
      y: z.number().min(0).max(1),
    })
    .nullable(),
});
export type LookItem = z.infer<typeof lookItemSchema>;

/** `GET /v1/looks/:lookId`: everything the look page shows. */
export const lookDetailSchema = z.object({
  id: z.uuid(),
  slug: z.string(),
  caption: z.string().nullable(),
  publishedAt: z.iso.datetime(),
  /** In order; the first is the cover. Photos not ready yet are left out. */
  photos: z.array(photoSchema).min(1).max(MAX_LOOK_PHOTOS),
  author: lookAuthorSchema,
  /** Whether the viewer saved it (false when logged out). */
  saved: z.boolean(),
  /** Same as `items.length` (and the feed card's count). */
  itemCount: z.number().int().nonnegative(),
  /** Its pieces, as the item list reads: outerwear first, accessories last. */
  items: z.array(lookItemSchema).max(MAX_LOOK_ITEMS),
});
export type LookDetail = z.infer<typeof lookDetailSchema>;

/** `PUT` / `DELETE /v1/follows/:profileId`. */
export const followStateSchema = z.object({ profileId: z.uuid(), following: z.boolean() });
export type FollowState = z.infer<typeof followStateSchema>;

/**
 * "Similar pieces" for a piece of a look: `nearest` first, or `cheaper`
 * (lowest price first among the nearest few; prices in the piece's own
 * currency come first, other currencies after, never mixed).
 */
export const SIMILAR_PIECE_SORTS = ['nearest', 'cheaper'] as const;
export type SimilarPieceSort = (typeof SIMILAR_PIECE_SORTS)[number];

/** `GET /v1/look-items/:itemId/similar?sort=&cursor=`. */
export const similarPiecesQuerySchema = z.object({
  sort: z.enum(SIMILAR_PIECE_SORTS).default('nearest'),
  cursor: z.string().min(1).max(300).optional(),
});
export type SimilarPiecesQuery = z.infer<typeof similarPiecesQuerySchema>;

/**
 * A product that looks like the piece, with one of its shop links: the one
 * on look `lookId` (a Shop tap is credited to that look, whose poster's
 * affiliate tags `url` keeps).
 */
export const similarPieceSchema = lookItemSchema
  .pick({
    offerId: true,
    productId: true,
    brand: true,
    name: true,
    category: true,
    price: true,
    stock: true,
    priceCheckedAt: true,
    url: true,
    shop: true,
  })
  .extend({
    /** Always our ready copy: products without one aren't shown. */
    image: photoSchema,
    /** The look this shop link is a piece of. */
    lookId: z.uuid(),
  });
export type SimilarPiece = z.infer<typeof similarPieceSchema>;

/** A page of similar pieces (20). `nextCursor` is null at the end. */
export const similarPiecesPageSchema = z.object({
  items: z.array(similarPieceSchema),
  nextCursor: z.string().nullable(),
});
export type SimilarPiecesPage = z.infer<typeof similarPiecesPageSchema>;
