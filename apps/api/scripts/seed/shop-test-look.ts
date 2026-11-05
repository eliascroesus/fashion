import { type Db, sql } from '@outfitly/db';
import type { GarmentCategory, OfferStock } from '@outfitly/shared';

/**
 * Test pieces on one look, for trying "shop the look" (Step 3.6) and its
 * Maestro flow before real links are verified. Every test link starts with
 * TEST_LINK and every test product has the brand TEST_BRAND, so removing
 * them never touches real data. As the look page lists them: three priced
 * pieces in stock, then one sold out, then one without a price.
 */
export const TEST_LINK = 'https://example.com/outfitly-test/';
export const TEST_BRAND = 'Outfitly test';

interface TestPiece {
  name: string;
  category: GarmentCategory;
  price: number | null;
  stock: OfferStock;
  daysAgo: number;
  dot: [number, number];
}

const PIECES: readonly TestPiece[] = [
  {
    name: 'Test coat',
    category: 'coat',
    price: 129900,
    stock: 'in_stock',
    daysAgo: 0,
    dot: [0.3, 0.25],
  },
  {
    name: 'Test knit',
    category: 'knitwear',
    price: 49950,
    stock: 'unknown',
    daysAgo: 1,
    dot: [0.7, 0.3],
  },
  {
    name: 'Test jeans',
    category: 'jeans',
    price: 59900,
    stock: 'in_stock',
    daysAgo: 0,
    dot: [0.75, 0.6],
  },
  {
    name: 'Test sneakers (sold out)',
    category: 'sneakers',
    price: 89900,
    stock: 'out_of_stock',
    daysAgo: 3,
    dot: [0.3, 0.85],
  },
  {
    name: 'Test bag (no price)',
    category: 'bag',
    price: null,
    stock: 'in_stock',
    daysAgo: 0,
    dot: [0.3, 0.6],
  },
];

/** The look to use: `lookId`, else the newest published look of @outfitly.picks. */
export async function pickTestLook(db: Db, lookId?: string): Promise<string | null> {
  const { rows } = await db.execute<{ id: string }>(sql`
    SELECT l.id FROM looks l JOIN profiles a ON a.id = l.author_profile_id
     WHERE l.status = 'published' AND l.deleted_at IS NULL
       AND ${lookId ? sql`l.id = ${lookId}` : sql`a.handle = 'outfitly.picks'`}
     ORDER BY l.published_at DESC LIMIT 1`);
  return rows[0]?.id ?? null;
}

/**
 * Adds the test pieces (verified, with dots on the cover) to the look,
 * after removing any earlier test pieces. Product photos reuse the look's
 * cover photo, so nothing is uploaded.
 */
export async function addShopTestLook(db: Db, lookId: string): Promise<number> {
  await removeShopTestPieces(db);
  return db.transaction(async (tx) => {
    const { rows } = await tx.execute<{ media_id: string }>(sql`
      SELECT media_id FROM look_media WHERE look_id = ${lookId} AND position = 0`);
    const cover = rows[0]?.media_id;
    if (!cover) throw new Error(`Look ${lookId} has no cover photo.`);
    for (const [n, piece] of PIECES.entries()) {
      const link = `${TEST_LINK}${String(n + 1)}`;
      await tx.execute(sql`
        WITH product AS (
          INSERT INTO products (name, brand, category, image_media_id)
          VALUES (${piece.name}, ${TEST_BRAND}, ${piece.category}, ${cover}) RETURNING id),
        offer AS (
          INSERT INTO offers (product_id, url, page_url, price_minor, currency, stock, last_checked_at)
          SELECT id, ${`${link}?aff=test`}, ${link}, ${piece.price}::int,
                 ${piece.price === null ? null : 'SEK'}, ${piece.stock},
                 now() - ${piece.daysAgo} * interval '1 day'
            FROM product RETURNING id)
        INSERT INTO look_items (look_id, offer_id, media_id, dot_x, dot_y, status)
        SELECT ${lookId}, id, ${cover}, ${piece.dot[0]}, ${piece.dot[1]}, 'verified' FROM offer`);
    }
    return PIECES.length;
  });
}

/** Deletes every test piece, link and product (on any look). Returns the pieces deleted. */
export async function removeShopTestPieces(db: Db): Promise<number> {
  return db.transaction(async (tx) => {
    const like = `${TEST_LINK}%`;
    // Shop taps made while trying it out (clicks have no foreign keys, so they'd stay).
    await tx.execute(sql`
      DELETE FROM clicks WHERE offer_id IN (SELECT id FROM offers WHERE url LIKE ${like})`);
    const items = await tx.execute(sql`
      DELETE FROM look_items WHERE offer_id IN (SELECT id FROM offers WHERE url LIKE ${like})`);
    await tx.execute(sql`DELETE FROM offers WHERE url LIKE ${like}`);
    await tx.execute(sql`
      DELETE FROM products p WHERE p.brand = ${TEST_BRAND}
         AND NOT EXISTS (SELECT 1 FROM offers o WHERE o.product_id = p.id)`);
    return items.rowCount ?? 0;
  });
}

/** Look-alike test coats `addLookalikeCoats` puts on other looks, priced apart for "Cheaper". */
const LOOKALIKE_PRICES = [99900, 59900, 149900, 79900] as const;

/**
 * For trying "similar pieces" (Step 3.8) after `addShopTestLook`: the test
 * coat gets the look's cover fingerprint as its shop photo's, and a test coat
 * goes on each of the looks whose covers look most like it (that cover as
 * its photo and fingerprint). Needs fingerprinted covers (`pnpm
 * ai:fingerprint`); without them nothing is added. Returns how many coats.
 */
export async function addLookalikeCoats(db: Db, lookId: string): Promise<number> {
  return db.transaction(async (tx) => {
    const cover = sql`(SELECT m.embedding FROM look_media lm JOIN media m ON m.id = lm.media_id
                        WHERE lm.look_id = ${lookId} AND lm.position = 0)`;
    const { rows: coat } = await tx.execute<{ id: string }>(sql`
      UPDATE products p
         SET embedding = ${cover},
             embedding_model = (SELECT m.embedding_model FROM look_media lm
                                  JOIN media m ON m.id = lm.media_id
                                 WHERE lm.look_id = ${lookId} AND lm.position = 0)
       WHERE p.brand = ${TEST_BRAND} AND p.name = 'Test coat' AND ${cover} IS NOT NULL
         AND EXISTS (SELECT 1 FROM offers o JOIN look_items li ON li.offer_id = o.id
                      WHERE o.product_id = p.id AND li.look_id = ${lookId})
      RETURNING p.id`);
    if (coat.length === 0) return 0;
    const { rows: near } = await tx.execute<{ look_id: string; media_id: string }>(sql`
      SELECT lm.look_id, m.id AS media_id
        FROM media m JOIN look_media lm ON lm.media_id = m.id AND lm.position = 0
        JOIN looks l ON l.id = lm.look_id
       WHERE m.embedding IS NOT NULL AND m.status = 'ready' AND l.id <> ${lookId}
         AND l.status = 'published' AND l.deleted_at IS NULL
       ORDER BY m.embedding <=> ${cover}, l.id
       LIMIT ${LOOKALIKE_PRICES.length}`);
    for (const [n, other] of near.entries()) {
      const link = `${TEST_LINK}lookalike-${String(n + 1)}`;
      await tx.execute(sql`
        WITH product AS (
          INSERT INTO products (name, brand, category, image_media_id, embedding, embedding_model)
          SELECT ${`Test look-alike coat ${String(n + 1)}`}, ${TEST_BRAND}, 'coat', m.id,
                 m.embedding, m.embedding_model
            FROM media m WHERE m.id = ${other.media_id} RETURNING id),
        offer AS (
          INSERT INTO offers (product_id, url, page_url, price_minor, currency, stock, last_checked_at)
          SELECT id, ${`${link}?aff=test`}, ${link}, ${LOOKALIKE_PRICES[n] ?? null}::int, 'SEK',
                 'in_stock', now()
            FROM product RETURNING id)
        INSERT INTO look_items (look_id, offer_id, status)
        SELECT ${other.look_id}, id, 'verified' FROM offer`);
    }
    return near.length;
  });
}
