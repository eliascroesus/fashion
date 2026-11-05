import { sql, type SQL } from '@outfitly/db';
import {
  FEED_PAGE_SIZE,
  type GarmentCategory,
  type OfferStock,
  type SimilarPiece,
  type SimilarPieceSort,
  type SimilarPiecesPage,
} from '@outfitly/shared';
import { z } from 'zod';
import { ApiError } from './errors.ts';
import {
  decodeCursor,
  encodeCursor,
  type FeedDeps,
  type PhotoRow,
  photoColumns,
  showableLook,
  toPhoto,
} from './feed/cards.ts';
import { siteOf } from './links/urls.ts';
import { SHOWN_ITEM, SHOWN_ITEM_JOINS } from './shown-items.ts';
import { widenVectorSearch } from './similar-looks.ts';

export const SIMILAR_PIECE_RULES = {
  /** Nearest products read from the fingerprint index before the rules filter them. */
  candidates: 300,
  /** "Cheaper" sorts only this many of the nearest (beyond them, a cheaper piece is a worse match). */
  cheaperAmong: 60,
} as const;

/** Distances are compared rounded, so a cursor's value always equals itself when read back. */
const DISTANCE_DIGITS = 9;
const decimal = z.string().regex(/^-?\d{1,3}(\.\d{1,9})?$/);

/** Where the next page starts: the last piece's rank (`g`roup, `c`urrency, `p`rice, `d`istance, id). */
const cursorSchema = z.object({
  s: z.enum(['nearest', 'cheaper']),
  g: z.number().int().min(0).max(2),
  c: z.string().max(3),
  p: z.number().int().nonnegative(),
  d: decimal,
  id: z.uuid(),
});

interface PieceRow extends PhotoRow {
  product_id: string;
  offer_id: string;
  look_id: string;
  name: string;
  brand: string | null;
  category: GarmentCategory | null;
  price_minor: number | null;
  currency: string | null;
  stock: OfferStock;
  last_checked_at: Date | null;
  url: string;
  page_url: string;
  /** numeric, as text. */
  distance: string;
  price_group: number;
  sort_currency: string;
  sort_price: number;
}

const notFound = () => new ApiError(404, 'not_found', 'Piece not found.');

/** A real price (0 is never one), in minor units, else null. */
const priced = (column: SQL) => sql`(CASE WHEN ${column} > 0 THEN ${column} END)`;

function siteOfLink(link: string): string {
  try {
    return siteOf(new URL(link).hostname);
  } catch {
    return '';
  }
}

/**
 * "Similar pieces" for one piece of a look (a shown look item): other
 * products whose shop photos look most like it, of the same kind when that's
 * known. Compared with the piece as worn (the garment the link check
 * matched, or the poster's pick) when it has a fingerprint, else with the
 * product's own photo; fingerprints of the same model only. Only products
 * with our photo and a shop link that is a shown piece of a shown look, not
 * sold out (a Shop tap is credited to that look). `cheaper` takes the
 * nearest SIMILAR_PIECE_RULES.cheaperAmong and puts prices in the piece's
 * currency first, lowest first; other currencies after (by currency, then
 * price; never compared), pieces without a price last. 20 per page.
 */
export async function similarPiecesPage(
  { db, storage }: FeedDeps,
  itemId: string,
  sort: SimilarPieceSort,
  cursor: string | undefined,
): Promise<SimilarPiecesPage> {
  const after = cursor === undefined ? undefined : decodeCursor(cursorSchema, cursor);
  if (after && after.s !== sort) throw new ApiError(400, 'validation_failed', 'Invalid cursor.');

  const { rows: found } = await db.execute<{ id: string }>(sql`
    SELECT li.id FROM look_items li ${SHOWN_ITEM_JOINS} JOIN looks l ON l.id = li.look_id
     WHERE li.id = ${itemId} AND ${SHOWN_ITEM} AND ${showableLook(sql`l`)} AND l.published_at <= now()`);
  if (found.length === 0) throw notFound();

  const rank =
    sort === 'nearest'
      ? sql`ORDER BY c.distance, c.product_id`
      : sql`ORDER BY c.price_group, c.sort_currency, c.sort_price, c.distance, c.product_id`;
  const keyset = after
    ? sort === 'nearest'
      ? sql`WHERE (c.distance, c.product_id) > (${after.d}::numeric, ${after.id}::uuid)`
      : sql`WHERE (c.price_group, c.sort_currency, c.sort_price, c.distance, c.product_id)
                > (${after.g}::int, ${after.c}::text, ${after.p}::int, ${after.d}::numeric, ${after.id}::uuid)`
    : sql``;

  const rows = await db.transaction(async (tx) => {
    await widenVectorSearch(tx);
    const { rows: result } = await tx.execute<PieceRow>(sql`
      WITH piece AS (
        SELECT p.id AS product_id, o.currency,
               coalesce(p.category, mg.category, pg.category) AS category,
               CASE WHEN g.embedding IS NOT NULL THEN g.embedding ELSE p.embedding END AS embedding,
               CASE WHEN g.embedding IS NOT NULL THEN g.embedding_model ELSE p.embedding_model END AS model
          FROM look_items li ${SHOWN_ITEM_JOINS}
          LEFT JOIN garments mg ON mg.id = li.matched_garment_id AND mg.deleted_at IS NULL
          LEFT JOIN garments pg ON pg.id = li.garment_id AND pg.deleted_at IS NULL
          LEFT JOIN garments g ON g.id = coalesce(mg.id, pg.id) AND g.embedding IS NOT NULL
         WHERE li.id = ${itemId}
      ),
      near AS MATERIALIZED (
        SELECT p.id, round((p.embedding <=> (SELECT embedding FROM piece))::numeric, ${DISTANCE_DIGITS}) AS distance
          FROM products p
         WHERE p.embedding_model = (SELECT model FROM piece) AND p.deleted_at IS NULL
         ORDER BY p.embedding <=> (SELECT embedding FROM piece)
         LIMIT ${SIMILAR_PIECE_RULES.candidates}
      ),
      -- Each product once, with its best shop link on a shown look: in stock, in the piece's
      -- currency, cheapest, on the most popular look.
      carried AS (
        SELECT DISTINCT ON (near.id)
               near.id AS product_id, near.distance, o.id AS offer_id, li.look_id, p.name, p.brand,
               coalesce(p.category, mg.category, pg.category) AS category,
               ${priced(sql`o.price_minor`)} AS price_minor, o.currency, o.stock, o.last_checked_at,
               o.url, o.page_url,
               pm.width, pm.height, pm.thumbhash, pm.dominant_color, pm.key_1080, pm.key_600, pm.key_300
          FROM near
          JOIN offers o ON o.product_id = near.id AND o.deleted_at IS NULL AND o.stock <> 'out_of_stock'
          JOIN look_items li ON li.offer_id = o.id
          JOIN products p ON p.id = near.id
          JOIN looks l ON l.id = li.look_id
          JOIN media pm ON pm.id = p.image_media_id AND pm.status = 'ready' AND pm.deleted_at IS NULL
          LEFT JOIN garments mg ON mg.id = li.matched_garment_id AND mg.deleted_at IS NULL
          LEFT JOIN garments pg ON pg.id = li.garment_id AND pg.deleted_at IS NULL
         WHERE near.id <> (SELECT product_id FROM piece) AND ${SHOWN_ITEM}
           AND ${showableLook(sql`l`)} AND l.published_at <= now()
         ORDER BY near.id, o.stock = 'in_stock' DESC,
                  o.currency IS NOT DISTINCT FROM (SELECT currency FROM piece) DESC,
                  ${priced(sql`o.price_minor`)} NULLS LAST, l.popularity_score DESC, li.id
      ),
      kind AS (
        SELECT carried.* FROM carried
         WHERE (SELECT category FROM piece) IS NULL OR carried.category = (SELECT category FROM piece)
         ORDER BY carried.distance, carried.product_id
         ${sort === 'cheaper' ? sql`LIMIT ${SIMILAR_PIECE_RULES.cheaperAmong}` : sql``}
      ),
      c AS (
        SELECT kind.*,
               CASE WHEN kind.price_minor IS NULL THEN 2
                    WHEN kind.currency IS NOT DISTINCT FROM (SELECT currency FROM piece) THEN 0
                    ELSE 1 END AS price_group,
               CASE WHEN kind.price_minor IS NULL THEN '' ELSE coalesce(kind.currency, '') END AS sort_currency,
               coalesce(kind.price_minor, 0) AS sort_price
          FROM kind
      )
      SELECT c.* FROM c ${keyset} ${rank}
       LIMIT ${FEED_PAGE_SIZE + 1}`);
    return result;
  });

  const page = rows.slice(0, FEED_PAGE_SIZE);
  const items = page.flatMap((r): SimilarPiece[] => {
    const image = toPhoto(storage, photoColumns(r));
    if (!image) return [];
    return [
      {
        offerId: r.offer_id,
        productId: r.product_id,
        lookId: r.look_id,
        brand: r.brand,
        name: r.name,
        category: r.category,
        image,
        price:
          r.price_minor === null || r.currency === null
            ? null
            : { amountMinor: r.price_minor, currency: r.currency },
        stock: r.stock,
        priceCheckedAt: r.last_checked_at ? new Date(r.last_checked_at).toISOString() : null,
        url: r.url,
        shop: siteOfLink(r.page_url),
      },
    ];
  });
  const last = page.at(-1);
  return {
    items,
    nextCursor:
      rows.length > FEED_PAGE_SIZE && last
        ? encodeCursor({
            s: sort,
            g: last.price_group,
            c: last.sort_currency,
            p: last.sort_price,
            d: last.distance,
            id: last.product_id,
          })
        : null,
  };
}
