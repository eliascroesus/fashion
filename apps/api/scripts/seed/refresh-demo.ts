import { type Db, eq, lookItems, products, sql } from '@outfitly/db';
import type { NetworkPolicy } from '../../src/links/fetch.ts';
import { readShopLink, saveLinkRead } from '../../src/links/resolve.ts';
import { TEST_BRAND } from './shop-test-look.ts';

/**
 * A test piece whose shop page is our own: a tiny product page in our public
 * R2 bucket, for showing the price and stock check (Step 3.9) end to end
 * without asking a real shop anything. The page is read like a pasted link,
 * the piece goes on a look as verified, and flipping the page to sold out
 * then running the check greys it. Everything is found again by the page's
 * address (under `DEMO_PREFIX`) and the test brand.
 */
export const DEMO_PREFIX = 'test/refresh-demo/';
export const DEMO_NAME = 'Refresh demo coat';

/** The demo page: one product (JSON-LD), in stock or sold out, priced 1 499 kr. */
export function demoPageHtml(pageUrl: string, stock: 'InStock' | 'OutOfStock'): string {
  const product = {
    '@context': 'https://schema.org',
    '@type': 'Product',
    name: DEMO_NAME,
    brand: { '@type': 'Brand', name: TEST_BRAND },
    offers: {
      '@type': 'Offer',
      price: '1499.00',
      priceCurrency: 'SEK',
      availability: `https://schema.org/${stock}`,
    },
  };
  return `<!doctype html><html lang="sv"><head><meta charset="utf-8">
<title>${DEMO_NAME} (Outfitly test page)</title>
<link rel="canonical" href="${pageUrl}">
<meta name="robots" content="noindex">
<script type="application/ld+json">${JSON.stringify(product)}</script>
</head><body><h1>${DEMO_NAME}</h1><p>A test page for Outfitly's price check.</p></body></html>`;
}

/**
 * Reads the demo page like a pasted link (with an affiliate tag, to show it's
 * kept) and puts it on the look as a verified piece. Its product photo is the
 * look's cover (nothing is copied). Returns the offer and look item.
 */
export async function attachDemoPiece(
  db: Db,
  lookId: string,
  pageUrl: string,
  network?: NetworkPolicy,
): Promise<{ offerId: string; lookItemId: string }> {
  const read = await readShopLink(new URL(`${pageUrl}?aff=demo`), { network });
  const saved = await saveLinkRead(db, read);
  const { rows } = await db.execute<{ media_id: string }>(sql`
    SELECT media_id FROM look_media WHERE look_id = ${lookId} AND position = 0`);
  const cover = rows[0]?.media_id;
  if (!cover) throw new Error(`Look ${lookId} has no cover photo.`);
  await db
    .update(products)
    .set({ imageMediaId: cover, category: 'coat' })
    .where(eq(products.id, saved.productId));
  const [item] = await db
    .insert(lookItems)
    .values({
      lookId,
      offerId: saved.offerId,
      mediaId: cover,
      dotX: 0.5,
      dotY: 0.4,
      status: 'verified',
    })
    .onConflictDoNothing()
    .returning({ id: lookItems.id });
  const lookItemId =
    item?.id ??
    (
      await db
        .select({ id: lookItems.id })
        .from(lookItems)
        .where(sql`${lookItems.lookId} = ${lookId} AND ${lookItems.offerId} = ${saved.offerId}`)
    )[0]?.id;
  if (!lookItemId) throw new Error('Demo piece not saved.');
  return { offerId: saved.offerId, lookItemId };
}

/** `text` as a LIKE pattern that matches only itself (`%`, `_` and backslashes escaped). */
function literalLike(text: string): string {
  return text.replace(/[\\%_]/g, (c) => `\\${c}`);
}

/**
 * Deletes every demo piece, link and product (and clicks on them): links to a
 * demo page, and links of the demo product (test brand and name). Returns the
 * pieces deleted.
 */
export async function removeDemoPieces(db: Db, publicBaseUrl: string): Promise<number> {
  const like = `${literalLike(`${publicBaseUrl.replace(/\/$/, '')}/${DEMO_PREFIX}`)}%`;
  return db.transaction(async (tx) => {
    const demo = sql`(SELECT o.id FROM offers o JOIN products p ON p.id = o.product_id
                       WHERE o.page_url LIKE ${like}
                          OR (p.brand = ${TEST_BRAND} AND p.name = ${DEMO_NAME}))`;
    await tx.execute(sql`DELETE FROM clicks WHERE offer_id IN ${demo}`);
    const items = await tx.execute(sql`DELETE FROM look_items WHERE offer_id IN ${demo}`);
    await tx.execute(sql`DELETE FROM offers WHERE id IN ${demo}`);
    await tx.execute(sql`
      DELETE FROM products p WHERE p.brand = ${TEST_BRAND} AND p.name = ${DEMO_NAME}
         AND NOT EXISTS (SELECT 1 FROM offers o WHERE o.product_id = p.id)`);
    return items.rowCount ?? 0;
  });
}
