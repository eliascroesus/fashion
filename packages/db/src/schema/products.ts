import { GARMENT_CATEGORIES, LINK_CHECK_REASONS } from '@outfitly/shared';
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
    /** When copying the shop's photo in was refused (a broken or unusable picture); cleared by a new one. */
    imageFailedAt: timestamp('image_failed_at', { withTimezone: true }),
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
 * What an offer's last price and stock check found (Step 3.9): read fine,
 * the page now shows another item, the page is gone, the shop turned us away,
 * it didn't answer, the page had no product we could read, or it showed the
 * price in another currency (left as it was: shops change currency by where
 * the reader is; migration 0020).
 */
export const OFFER_REFRESH_OUTCOMES = [
  'ok',
  'moved',
  'gone',
  'blocked',
  'failed',
  'unreadable',
  'currency_changed',
] as const;

/**
 * Which shop sells a product, at what price. `url` is the poster's link as
 * given, affiliate tags kept: Shop opens it. `page_url` is the shop's product
 * page it lands on (after redirects, tracking removed): price and stock checks
 * read that one, so a check never counts as a click on someone's affiliate link.
 * Prices are in minor units (öre, cents). `price_history` gets an entry each
 * time the price changes. `last_checked_at` is the last time the page was
 * read; the `refresh_*` columns are the daily / weekly check's own record
 * (Step 3.9), failed tries included.
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
    /** The last check's try, whatever it found. */
    refreshTriedAt: timestamp('refresh_tried_at', { withTimezone: true }),
    refreshOutcome: text('refresh_outcome', { enum: OFFER_REFRESH_OUTCOMES }),
    /** Checks in a row that couldn't read the page; a successful read starts over. */
    refreshFailures: integer('refresh_failures').notNull().default(0),
    /** Checks in a row that found the page gone; at `goneAfter` the offer counts as sold out. */
    refreshGone: integer('refresh_gone').notNull().default(0),
    /** Not checked again before this: tomorrow after a read, later after each failure. */
    refreshDueAt: timestamp('refresh_due_at', { withTimezone: true }),
    ...softDelete(),
  },
  (t) => [
    uniqueIndex('offers_url_key').on(t.url),
    index('offers_product_id_idx').on(t.productId),
    // Every link to a shop page is found (and checked) together.
    index('offers_page_url_idx')
      .on(t.pageUrl)
      .where(sql`${t.deletedAt} is null`),
    check(
      'offers_refresh_outcome_known',
      sql`${t.refreshOutcome} in (${sql.raw(OFFER_REFRESH_OUTCOMES.map((o) => `'${o}'`).join(', '))})`,
    ),
    check('offers_refresh_counts', sql`${t.refreshFailures} >= 0 and ${t.refreshGone} >= 0`),
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
 * One run of the price and stock check (Step 3.9, every 10 minutes): shop
 * pages read for saved or popular looks and for the rest (the two daily caps
 * count these), and what was found (`{ ok, priceChanged, soldOut, … }`).
 */
export const priceRefreshRuns = pgTable(
  'price_refresh_runs',
  {
    ...baseColumns(),
    finishedAt: timestamp('finished_at', { withTimezone: true }),
    readsSavedOrPopular: integer('reads_saved_or_popular').notNull().default(0),
    readsOthers: integer('reads_others').notNull().default(0),
    found: jsonb('found').$type<Record<string, number>>().notNull().default({}),
  },
  (t) => [
    index('price_refresh_runs_created_at_idx').on(t.createdAt),
    check(
      'price_refresh_runs_reads_not_negative',
      sql`${t.readsSavedOrPopular} >= 0 and ${t.readsOthers} >= 0`,
    ),
    check('price_refresh_runs_found_is_object', sql`jsonb_typeof(${t.found}) = 'object'`),
  ],
).enableRLS();

/**
 * Shops (sites, `www.` / `m.` left out) that turned the check away or didn't
 * answer: none of their pages is read before `rest_until`, which gets longer
 * each time in a row (`strikes`). A successful read removes the row.
 */
export const priceRefreshSites = pgTable(
  'price_refresh_sites',
  {
    ...baseColumns(),
    site: text('site').notNull(),
    restUntil: timestamp('rest_until', { withTimezone: true }).notNull(),
    lastProblem: text('last_problem').notNull(),
    strikes: integer('strikes').notNull().default(1),
  },
  (t) => [
    uniqueIndex('price_refresh_sites_site_key').on(t.site),
    check('price_refresh_sites_strikes_positive', sql`${t.strikes} >= 1`),
  ],
).enableRLS();

/**
 * The "shop the look" list: an offer shown on a look. `garment_id` is the
 * piece the poster picked (if they did); `matched_garment_id` the piece the
 * link check compared the product with (Step 3.5: the poster's pick, the
 * piece under their dot, or the most alike piece). The dot sits on a photo,
 * in fractions of it like garment boxes (no photo = no dot); the API makes
 * sure it's one of the look's photos. `match_score` is the cosine similarity
 * of the matched garment's and product's fingerprints. `pending_since`: when
 * it last started waiting for a check; `checked_at`: when the check last ran.
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
    matchedGarmentId: uuid('matched_garment_id').references(() => garments.id, {
      onDelete: 'set null',
    }),
    mediaId: uuid('media_id').references(() => media.id),
    dotX: real('dot_x'),
    dotY: real('dot_y'),
    matchScore: real('match_score'),
    status: lookItemStatus('status').notNull().default('pending'),
    pendingSince: timestamp('pending_since', { withTimezone: true }).defaultNow(),
    checkedAt: timestamp('checked_at', { withTimezone: true }),
    ...softDelete(),
  },
  (t) => [
    // One row per look and offer: removing sets deleted_at, adding again clears it.
    uniqueIndex('look_items_look_offer_key').on(t.lookId, t.offerId),
    index('look_items_offer_id_idx').on(t.offerId),
    index('look_items_garment_id_idx').on(t.garmentId),
    index('look_items_matched_garment_id_idx').on(t.matchedGarmentId),
    // The hourly sweep: pending items, least recently tried first.
    index('look_items_pending_idx')
      .on(t.checkedAt)
      .where(sql`${t.status} = 'pending' and ${t.deletedAt} is null`),
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
    check(
      'link_checks_reason_known',
      sql`${t.reason} in (${sql.raw(LINK_CHECK_REASONS.map((r) => `'${r}'`).join(', '))})`,
    ),
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
    /** Which list (screen) the look was opened from, like `events.source` (`CLICK_SOURCES`). */
    source: text('source'),
    platform: clientPlatform('platform').notNull(),
  },
  (t) => [
    index('clicks_created_at_idx').on(t.createdAt),
    check('clicks_has_viewer', sql`${t.profileId} is not null or ${t.sessionId} is not null`),
    check('clicks_position_not_negative', sql`${t.position} >= 0`),
  ],
).enableRLS();
