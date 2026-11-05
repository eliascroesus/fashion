import { GARMENT_CATEGORIES } from '@outfitly/shared';
import { sql } from 'drizzle-orm';
import {
  type AnyPgColumn,
  check,
  index,
  integer,
  jsonb,
  pgEnum,
  pgTable,
  real,
  text,
  timestamp,
  uniqueIndex,
  uuid,
} from 'drizzle-orm/pg-core';
import { baseColumns, fingerprint, softDelete } from './columns.ts';
import { clientPlatform } from './events.ts';
import { looks } from './looks.ts';
import { media } from './media.ts';
import { profiles } from './profiles.ts';

export const garmentCategory = pgEnum('garment_category', GARMENT_CATEGORIES);
export const offerStock = pgEnum('offer_stock', ['in_stock', 'out_of_stock', 'unknown']);
/** pending = not checked yet (or waiting for a fingerprint or the AI); review = waiting for a person. */
export const lookItemStatus = pgEnum('look_item_status', [
  'pending',
  'verified',
  'rejected',
  'review',
]);
export const linkCheckAnswer = pgEnum('link_check_answer', ['yes', 'no', 'unsure']);
export const linkCheckOutcome = pgEnum('link_check_outcome', ['verified', 'review', 'rejected']);

/** Longest link we keep: the unique index on `offers.url` can't hold much more. */
const MAX_URL_BYTES = 2048;

/**
 * Each piece the AI spotted in a photo. The box is in fractions of the photo
 * (0 = left/top edge, 1 = right/bottom edge), so it fits every served size.
 * `attributes` holds what Step 3.3 reads besides the category and colour
 * (pattern, material, visible brand text…). The fingerprint is of the cropped box.
 */
export const garments = pgTable(
  'garments',
  {
    ...baseColumns(),
    mediaId: uuid('media_id')
      .notNull()
      .references(() => media.id, { onDelete: 'cascade' }),
    category: garmentCategory('category').notNull(),
    color: text('color'),
    attributes: jsonb('attributes').$type<Record<string, unknown>>().notNull().default({}),
    boxLeft: real('box_left').notNull(),
    boxTop: real('box_top').notNull(),
    boxRight: real('box_right').notNull(),
    boxBottom: real('box_bottom').notNull(),
    ...fingerprint(),
    ...softDelete(),
  },
  (t) => [
    index('garments_media_id_idx').on(t.mediaId),
    index('garments_embedding_idx').using('hnsw', t.embedding.op('halfvec_cosine_ops')),
    check(
      'garments_box_inside_photo',
      sql`${t.boxLeft} >= 0 and ${t.boxTop} >= 0 and ${t.boxRight} <= 1 and ${t.boxBottom} <= 1 and ${t.boxLeft} < ${t.boxRight} and ${t.boxTop} < ${t.boxBottom}`,
    ),
    check('garments_attributes_is_object', sql`jsonb_typeof(${t.attributes}) = 'object'`),
  ],
).enableRLS();

/**
 * The item itself, whichever shops sell it ("the same jacket" across shops;
 * shops and prices are in `offers`). `gtin` is the barcode when the shop gives
 * one. `image_url` is the shop's photo; `image_media_id` our processed copy
 * (the only one served). Owned by a business profile when it's on their
 * Products tab.
 */
export const products = pgTable(
  'products',
  {
    ...baseColumns(),
    name: text('name').notNull(),
    brand: text('brand'),
    /** Unknown until the AI or a linked garment says. */
    category: garmentCategory('category'),
    gtin: text('gtin'),
    imageUrl: text('image_url'),
    imageMediaId: uuid('image_media_id').references(() => media.id, { onDelete: 'set null' }),
    ...fingerprint(),
    ownerProfileId: uuid('owner_profile_id').references((): AnyPgColumn => profiles.id),
    ...softDelete(),
  },
  (t) => [
    uniqueIndex('products_gtin_key')
      .on(t.gtin)
      .where(sql`${t.gtin} is not null`),
    index('products_owner_profile_id_idx').on(t.ownerProfileId),
    // So deleting a photo doesn't read every product.
    index('products_image_media_id_idx')
      .on(t.imageMediaId)
      .where(sql`${t.imageMediaId} is not null`),
    index('products_embedding_idx').using('hnsw', t.embedding.op('halfvec_cosine_ops')),
    check('products_name_length', sql`char_length(${t.name}) between 1 and 300`),
    check('products_gtin_format', sql`${t.gtin} ~ '^[0-9]{8,14}$'`),
    check('products_image_url_web', sql`${t.imageUrl} ~ '^https?://'`),
  ],
).enableRLS();

/**
 * Which shop sells a product, at what price. `url` is the poster's link as
 * given, affiliate tags kept: Shop opens it. `page_url` is the shop's product
 * page it lands on (after redirects, tracking removed): price and stock checks
 * read that one, so a check never counts as a click on someone's affiliate link.
 * Prices are in minor units (öre, cents). `price_history` gets an entry each
 * time the price changes (Step 3.9).
 */
export const offers = pgTable(
  'offers',
  {
    ...baseColumns(),
    productId: uuid('product_id')
      .notNull()
      .references(() => products.id),
    url: text('url').notNull(),
    pageUrl: text('page_url').notNull(),
    priceMinor: integer('price_minor'),
    currency: text('currency'),
    stock: offerStock('stock').notNull().default('unknown'),
    lastCheckedAt: timestamp('last_checked_at', { withTimezone: true }),
    priceHistory: jsonb('price_history').$type<unknown[]>().notNull().default([]),
    ...softDelete(),
  },
  (t) => [
    uniqueIndex('offers_url_key').on(t.url),
    index('offers_product_id_idx').on(t.productId),
    check('offers_url_web', sql`${t.url} ~ '^https?://' and ${t.pageUrl} ~ '^https?://'`),
    check(
      'offers_url_length',
      sql`octet_length(${t.url}) <= ${sql.raw(String(MAX_URL_BYTES))} and octet_length(${t.pageUrl}) <= ${sql.raw(String(MAX_URL_BYTES))}`,
    ),
    check('offers_price_has_currency', sql`(${t.priceMinor} is null) = (${t.currency} is null)`),
    check('offers_price_not_negative', sql`${t.priceMinor} >= 0`),
    check('offers_currency_format', sql`${t.currency} ~ '^[A-Z]{3}$'`),
    check('offers_price_history_is_list', sql`jsonb_typeof(${t.priceHistory}) = 'array'`),
  ],
).enableRLS();

/**
 * The "shop the look" list: an offer shown on a look, usually for a garment
 * the AI spotted. The dot sits on a photo, in fractions of it like garment
 * boxes (no photo = no dot); the API makes sure it's one of the look's photos. `match_score` is the cosine
 * similarity of the garment's and product's fingerprints (Step 3.5).
 */
export const lookItems = pgTable(
  'look_items',
  {
    ...baseColumns(),
    lookId: uuid('look_id')
      .notNull()
      .references(() => looks.id, { onDelete: 'cascade' }),
    offerId: uuid('offer_id')
      .notNull()
      .references(() => offers.id),
    garmentId: uuid('garment_id').references(() => garments.id, { onDelete: 'set null' }),
    mediaId: uuid('media_id').references(() => media.id),
    dotX: real('dot_x'),
    dotY: real('dot_y'),
    matchScore: real('match_score'),
    status: lookItemStatus('status').notNull().default('pending'),
    ...softDelete(),
  },
  (t) => [
    // One row per look and offer: removing sets deleted_at, adding again clears it.
    uniqueIndex('look_items_look_offer_key').on(t.lookId, t.offerId),
    index('look_items_offer_id_idx').on(t.offerId),
    index('look_items_garment_id_idx').on(t.garmentId),
    index('look_items_media_id_idx')
      .on(t.mediaId)
      .where(sql`${t.mediaId} is not null`),
    check(
      'look_items_dot_complete',
      sql`(${t.mediaId} is null) = (${t.dotX} is null) and (${t.mediaId} is null) = (${t.dotY} is null)`,
    ),
    check(
      'look_items_dot_inside_photo',
      sql`${t.dotX} between 0 and 1 and ${t.dotY} between 0 and 1`,
    ),
    check('look_items_match_score_range', sql`${t.matchScore} between -1 and 1`),
  ],
).enableRLS();

/**
 * Every automatic check of a look item's link (Step 3.5), kept as history.
 * `ai_answer` is set only when the score was in the middle and the AI was
 * asked. `reason` is a code the app turns into the poster's message;
 * `details` the thresholds and models used.
 */
export const linkChecks = pgTable(
  'link_checks',
  {
    ...baseColumns(),
    lookItemId: uuid('look_item_id')
      .notNull()
      .references(() => lookItems.id, { onDelete: 'cascade' }),
    similarity: real('similarity'),
    aiAnswer: linkCheckAnswer('ai_answer'),
    outcome: linkCheckOutcome('outcome').notNull(),
    reason: text('reason'),
    details: jsonb('details').$type<Record<string, unknown>>().notNull().default({}),
  },
  (t) => [
    index('link_checks_look_item_id_idx').on(t.lookItemId),
    check('link_checks_similarity_range', sql`${t.similarity} between -1 and 1`),
    check('link_checks_details_is_object', sql`jsonb_typeof(${t.details}) = 'object'`),
  ],
).enableRLS();

/**
 * Every tap on Shop: stats now, commissions later. The id is the random click
 * id passed on to shops. Who tapped is a profile, or a logged-out session.
 * `author_profile_id` is who gets credit (the look's poster). No foreign keys,
 * like `events`: clicks are history and stay as they happened. Append-only.
 */
export const clicks = pgTable(
  'clicks',
  {
    ...baseColumns(),
    profileId: uuid('profile_id'),
    sessionId: uuid('session_id'),
    lookId: uuid('look_id'),
    offerId: uuid('offer_id').notNull(),
    authorProfileId: uuid('author_profile_id'),
    /** Place of the look in the feed it was opened from (0-based). */
    position: integer('position'),
    /** Which screen, like `events.source`. */
    source: text('source'),
    platform: clientPlatform('platform').notNull(),
  },
  (t) => [
    index('clicks_created_at_idx').on(t.createdAt),
    check('clicks_has_viewer', sql`${t.profileId} is not null or ${t.sessionId} is not null`),
    check('clicks_position_not_negative', sql`${t.position} >= 0`),
  ],
).enableRLS();
