import { type Db, sql, type SQL } from '@outfitly/db';
import {
  GARMENT_CATEGORIES,
  type GarmentCategory,
  type LookItem,
  MAX_LOOK_ITEMS,
  type OfferStock,
} from '@outfitly/shared';
import { photoColumns, type PhotoRow, toPhoto } from './feed/cards.ts';
import { siteOf } from './links/urls.ts';
import { SHOWN_ITEM, SHOWN_ITEM_JOINS } from './shown-items.ts';
import type { PhotoStorage } from './storage.ts';

export interface ItemRow extends PhotoRow {
  id: string;
  offer_id: string;
  product_id: string;
  name: string;
  brand: string | null;
  product_category: GarmentCategory | null;
  price_minor: number | null;
  currency: string | null;
  stock: OfferStock;
  last_checked_at: Date | null;
  url: string;
  page_url: string;
  media_id: string | null;
  dot_x: number | null;
  dot_y: number | null;
  matched_media_id: string | null;
  matched_category: GarmentCategory | null;
  matched_x: number | null;
  matched_y: number | null;
  picked_media_id: string | null;
  picked_category: GarmentCategory | null;
  picked_x: number | null;
  picked_y: number | null;
}

/**
 * A garment's photo, kind and box middle as `<name>_media_id`, `_category`,
 * `_x`, `_y` (all null for no garment, or a soft-deleted one). Fixed aliases
 * only, never user input.
 */
function middleColumns(alias: 'mg' | 'pg', name: 'matched' | 'picked'): SQL {
  return sql.raw(
    `${alias}.media_id AS ${name}_media_id, ${alias}.category AS ${name}_category,
     (${alias}.box_left + ${alias}.box_right) / 2 AS ${name}_x,
     (${alias}.box_top + ${alias}.box_bottom) / 2 AS ${name}_y`,
  );
}

const CATEGORY_ORDER = new Map(GARMENT_CATEGORIES.map((c, i) => [c, i]));

function siteOfLink(link: string): string {
  try {
    return siteOf(new URL(link).hostname);
  } catch {
    return '';
  }
}

/** The look's shown pieces as stored, oldest first (at most MAX_LOOK_ITEMS). One query. */
export async function itemRows(db: Db, lookId: string): Promise<ItemRow[]> {
  const { rows } = await db.execute<ItemRow>(sql`
    SELECT li.id, li.offer_id, li.media_id, li.dot_x, li.dot_y,
           o.url, o.page_url, o.price_minor, o.currency, o.stock, o.last_checked_at,
           p.id AS product_id, p.name, p.brand, p.category AS product_category,
           pm.width, pm.height, pm.thumbhash, pm.dominant_color, pm.key_1080, pm.key_600, pm.key_300,
           ${middleColumns('mg', 'matched')}, ${middleColumns('pg', 'picked')}
      FROM look_items li ${SHOWN_ITEM_JOINS}
      LEFT JOIN media pm ON pm.id = p.image_media_id AND pm.status = 'ready'
                        AND pm.deleted_at IS NULL
      LEFT JOIN garments mg ON mg.id = li.matched_garment_id AND mg.deleted_at IS NULL
      LEFT JOIN garments pg ON pg.id = li.garment_id AND pg.deleted_at IS NULL
     WHERE li.look_id = ${lookId} AND ${SHOWN_ITEM}
     ORDER BY li.created_at, li.id
     LIMIT ${MAX_LOOK_ITEMS}`);
  return rows;
}

/**
 * The look's pieces as the look page lists them. `photoMediaIds` are the
 * look's shown photos in order (a dot must be on one of them). Each dot is
 * the poster's own, else the middle of the piece the link check matched,
 * else of the piece the poster picked. The list reads like
 * GARMENT_CATEGORIES (outerwear first, accessories last), then top to
 * bottom; pieces of no known kind come last.
 */
export function toLookItems(
  storage: PhotoStorage,
  rows: readonly ItemRow[],
  photoMediaIds: readonly string[],
): LookItem[] {
  const photoIndex = new Map(photoMediaIds.map((id, index) => [id, index]));
  const dotOn = (mediaId: string | null, x: number | null, y: number | null) => {
    const photo = mediaId === null ? undefined : photoIndex.get(mediaId);
    return photo === undefined || x === null || y === null ? null : { photo, x, y };
  };

  const items = rows.map((r) => {
    const dot =
      dotOn(r.media_id, r.dot_x, r.dot_y) ??
      dotOn(r.matched_media_id, r.matched_x, r.matched_y) ??
      dotOn(r.picked_media_id, r.picked_x, r.picked_y);
    const category = r.product_category ?? r.matched_category ?? r.picked_category;
    const item: LookItem = {
      id: r.id,
      offerId: r.offer_id,
      productId: r.product_id,
      brand: r.brand,
      name: r.name,
      category,
      image: toPhoto(storage, photoColumns(r)),
      // 0 is never a real price (links read before Step 3.6 may hold one).
      price:
        r.price_minor === null || r.price_minor <= 0 || r.currency === null
          ? null
          : { amountMinor: r.price_minor, currency: r.currency },
      stock: r.stock,
      priceCheckedAt: r.last_checked_at ? new Date(r.last_checked_at).toISOString() : null,
      url: r.url,
      shop: siteOfLink(r.page_url),
      dot,
    };
    return item;
  });

  const rank = (item: LookItem) => [
    item.category === null ? GARMENT_CATEGORIES.length : (CATEGORY_ORDER.get(item.category) ?? 0),
    item.dot?.photo ?? MAX_LOOK_ITEMS,
    item.dot?.y ?? 1,
  ];
  // Stable: pieces that rank the same keep the order they were added in.
  return items
    .map((item) => ({ item, key: rank(item) }))
    .sort((a, b) => {
      for (let i = 0; i < a.key.length; i += 1) {
        const diff = (a.key[i] ?? 0) - (b.key[i] ?? 0);
        if (diff !== 0) return diff;
      }
      return 0;
    })
    .map(({ item }) => item);
}
