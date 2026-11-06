import { sql, type SQL } from '@outfitly/db';
import { MAX_LOOK_ITEMS } from '@outfitly/shared';

/**
 * The pieces anyone may see on a look: look items (`li`) the link check
 * verified, whose shop link (`o`) and product (`p`) are still there. The look
 * page, the feed cards' piece count and board totals all use these two
 * fragments, so they always agree: `FROM look_items li ${SHOWN_ITEM_JOINS}
 * WHERE … AND ${SHOWN_ITEM}`.
 */
export const SHOWN_ITEM_JOINS = sql`JOIN offers o ON o.id = li.offer_id AND o.deleted_at IS NULL
  JOIN products p ON p.id = o.product_id AND p.deleted_at IS NULL`;
export const SHOWN_ITEM = sql`li.status = 'verified' AND li.deleted_at IS NULL`;

/** How many pieces the look with this id shows (a correlated subquery). */
export function itemCountOf(lookId: SQL): SQL<number> {
  return sql<number>`LEAST((SELECT count(*) FROM look_items li ${SHOWN_ITEM_JOINS}
                             WHERE li.look_id = ${lookId} AND ${SHOWN_ITEM}), ${MAX_LOOK_ITEMS})::int`;
}
