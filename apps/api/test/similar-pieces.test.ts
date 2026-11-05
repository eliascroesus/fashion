import { garments, lookItems, media, offers, products, sql } from '@outfitly/db';
import {
  FEED_PAGE_SIZE,
  type GarmentCategory,
  type OfferStock,
  type SimilarPiecesPage,
  similarPiecesPageSchema,
} from '@outfitly/shared';
import type { FastifyInstance } from 'fastify';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createAuthor, createLook } from './feed-fixtures.ts';
import { buildTestApp, createTestContext, type TestContext } from './helpers.ts';
import { angled } from './vectors.ts';

const MODEL = 'Marqo/marqo-fashionSigLIP@c56244c';

let ctx: TestContext;
let app: FastifyInstance;
let author: string;

beforeAll(async () => {
  ctx = await createTestContext();
  app = await buildTestApp(ctx);
  await app.ready();
  author = await createAuthor(ctx.db, 'pieces.author');
});

afterAll(async () => {
  await app.close();
  await ctx.close();
});

const halfvec = (vector: number[]) => sql`${`[${vector.join(',')}]`}::extensions.halfvec`;

interface PieceSpec {
  /** The product's shop photo fingerprint. */
  vector: number[];
  model?: string;
  category?: GarmentCategory | null;
  price?: { amountMinor: number; currency: string } | null;
  stock?: OfferStock;
  photo?: boolean;
  /** The look item's status (default verified), or false for no look item at all. */
  item?: 'verified' | 'pending' | false;
  lookStatus?: 'published' | 'hidden';
  /** A garment the link check matched, with this kind and fingerprint. */
  garment?: { category: GarmentCategory; vector?: number[] };
  /** Another shop link to this product instead of a new product. */
  productId?: string;
}

interface Piece {
  productId: string;
  offerId: string;
  itemId: string;
  lookId: string;
}

/** A product (photo, fingerprint), a shop link to it, and that link as a piece of a new look. */
async function piece(spec: PieceSpec): Promise<Piece> {
  const lookId = await createLook(ctx.db, { authorId: author, status: spec.lookStatus });
  let productId = spec.productId;
  if (!productId) {
    productId = crypto.randomUUID();
    let imageMediaId: string | null = null;
    if (spec.photo !== false) {
      imageMediaId = crypto.randomUUID();
      await ctx.db.insert(media).values({
        id: imageMediaId,
        status: 'ready',
        sourceUrl: 'https://shop.test/p.jpg',
        originalKey: `originals/${imageMediaId}`,
        key1080: `m/${imageMediaId}/1080.webp`,
        key600: `m/${imageMediaId}/600.webp`,
        key300: `m/${imageMediaId}/300.webp`,
        width: 800,
        height: 1000,
        thumbhash: 'k0oGLQaSVsN0BVhn2oq2Z5SQUQcZ',
        dominantColor: '#c0b0a0',
      });
    }
    await ctx.db.insert(products).values({
      id: productId,
      name: 'Piece',
      brand: 'Acme',
      category: spec.category === undefined ? null : spec.category,
      imageMediaId,
    });
    await ctx.db.execute(sql`UPDATE products SET embedding = ${halfvec(spec.vector)},
                                embedding_model = ${spec.model ?? MODEL} WHERE id = ${productId}`);
  }
  const offerId = crypto.randomUUID();
  const price = spec.price === undefined ? { amountMinor: 99900, currency: 'SEK' } : spec.price;
  await ctx.db.insert(offers).values({
    id: offerId,
    productId,
    url: `https://www.shop.test/p/${offerId}?aff=poster`,
    pageUrl: `https://www.shop.test/p/${offerId}`,
    priceMinor: price?.amountMinor ?? null,
    currency: price?.currency ?? null,
    stock: spec.stock ?? 'in_stock',
  });
  let garmentId: string | null = null;
  if (spec.garment) {
    garmentId = crypto.randomUUID();
    const { rows } = await ctx.db.execute<{ media_id: string }>(
      sql`SELECT media_id FROM look_media WHERE look_id = ${lookId} AND position = 0`,
    );
    await ctx.db.insert(garments).values({
      id: garmentId,
      mediaId: rows[0]?.media_id ?? '',
      category: spec.garment.category,
      boxLeft: 0.2,
      boxTop: 0.2,
      boxRight: 0.8,
      boxBottom: 0.8,
    });
    if (spec.garment.vector) {
      await ctx.db.execute(sql`UPDATE garments SET embedding = ${halfvec(spec.garment.vector)},
                                  embedding_model = ${MODEL} WHERE id = ${garmentId}`);
    }
  }
  const itemId = crypto.randomUUID();
  if (spec.item !== false) {
    await ctx.db.insert(lookItems).values({
      id: itemId,
      lookId,
      offerId,
      matchedGarmentId: garmentId,
      status: spec.item ?? 'verified',
    });
  }
  return { productId, offerId, itemId, lookId };
}

async function similar(
  itemId: string,
  query: { sort?: string; cursor?: string | null } = {},
): Promise<SimilarPiecesPage> {
  const params = new URLSearchParams({
    ...(query.sort ? { sort: query.sort } : {}),
    ...(query.cursor ? { cursor: query.cursor } : {}),
  });
  const res = await app.inject({
    method: 'GET',
    url: `/v1/look-items/${itemId}/similar?${params.toString()}`,
  });
  expect(res.statusCode, res.body).toBe(200);
  return similarPiecesPageSchema.parse(res.json());
}

async function allPages(itemId: string, sort: string) {
  const pages = [await similar(itemId, { sort })];
  while (pages.at(-1)?.nextCursor) {
    pages.push(await similar(itemId, { sort, cursor: pages.at(-1)?.nextCursor }));
    if (pages.length > 20) throw new Error('never ends');
  }
  return pages.flatMap((p) => p.items);
}

describe('GET /v1/look-items/:itemId/similar', () => {
  it('lists the nearest products of the same kind, never the piece itself or ones that can’t be shopped', async () => {
    const at = (degrees: number) => angled(degrees, 0, 1);
    const base = await piece({ vector: at(0), category: 'coat' });
    const near = await piece({ vector: at(10), category: 'coat' });
    const middle = await piece({ vector: at(20), category: 'coat' });
    const far = await piece({ vector: at(30), category: 'coat' });
    // No kind on the product: the garment its link was matched with says coat.
    const byGarment = await piece({ vector: at(15), garment: { category: 'coat' } });
    const left = [
      await piece({ vector: at(1), category: 'dress' }),
      await piece({ vector: at(1), category: 'coat', stock: 'out_of_stock' }),
      await piece({ vector: at(1), category: 'coat', photo: false }),
      await piece({ vector: at(1), category: 'coat', item: 'pending' }),
      await piece({ vector: at(1), category: 'coat', item: false }),
      await piece({ vector: at(1), category: 'coat', lookStatus: 'hidden' }),
      await piece({ vector: at(0), category: 'coat', model: 'some-other-model' }),
      // Another shop link to the same product is still the same product.
      await piece({ vector: at(0), productId: base.productId }),
    ];

    const { items } = await similar(base.itemId);
    expect(items.map((i) => i.productId)).toEqual([
      near.productId,
      byGarment.productId,
      middle.productId,
      far.productId,
    ]);
    for (const p of left) expect(items.map((i) => i.offerId)).not.toContain(p.offerId);
    // Each comes with its shop link as a piece of its look (a Shop tap is credited there).
    expect(items[0]).toMatchObject({
      offerId: near.offerId,
      lookId: near.lookId,
      url: `https://www.shop.test/p/${near.offerId}?aff=poster`,
      shop: 'shop.test',
      price: { amountMinor: 99900, currency: 'SEK' },
      category: 'coat',
    });
  });

  it('compares with the piece as worn (its garment’s fingerprint) when it has one', async () => {
    const worn = angled(0, 2, 3);
    const shopPhoto = angled(0, 4, 5);
    const base = await piece({
      vector: shopPhoto,
      category: 'bag',
      garment: { category: 'bag', vector: worn },
    });
    const likeWorn = await piece({ vector: angled(20, 2, 3), category: 'bag' });
    const likeShopPhoto = await piece({ vector: angled(5, 4, 5), category: 'bag' });
    const { items } = await similar(base.itemId);
    expect(items.map((i) => i.productId)).toEqual([likeWorn.productId, likeShopPhoto.productId]);
  });

  it('sorts cheaper: the piece’s currency first, cheapest first; other currencies after; no price last', async () => {
    const at = (degrees: number) => angled(degrees, 6, 7);
    const base = await piece({ vector: at(0), category: 'boots' });
    const sek500 = await piece({
      vector: at(30),
      category: 'boots',
      price: { amountMinor: 50000, currency: 'SEK' },
    });
    const sek300 = await piece({
      vector: at(40),
      category: 'boots',
      price: { amountMinor: 30000, currency: 'SEK' },
    });
    const eur = await piece({
      vector: at(10),
      category: 'boots',
      price: { amountMinor: 2000, currency: 'EUR' },
    });
    const unpriced = await piece({ vector: at(5), category: 'boots', price: null });
    const sek900 = await piece({
      vector: at(20),
      category: 'boots',
      price: { amountMinor: 90000, currency: 'SEK' },
    });
    // A cheaper shop link to the same product, on another look: that one is shown.
    const cheaperLink = await piece({
      vector: at(0),
      productId: sek900.productId,
      price: { amountMinor: 80000, currency: 'SEK' },
    });
    await piece({
      vector: at(0),
      productId: sek900.productId,
      price: { amountMinor: 1000, currency: 'SEK' },
      stock: 'out_of_stock',
    });

    const nearest = await similar(base.itemId);
    expect(nearest.items.map((i) => i.productId)).toEqual([
      unpriced.productId,
      eur.productId,
      sek900.productId,
      sek500.productId,
      sek300.productId,
    ]);
    const cheaper = await similar(base.itemId, { sort: 'cheaper' });
    expect(cheaper.items.map((i) => i.productId)).toEqual([
      sek300.productId,
      sek500.productId,
      sek900.productId,
      eur.productId,
      unpriced.productId,
    ]);
    expect(cheaper.items[2]).toMatchObject({
      offerId: cheaperLink.offerId,
      lookId: cheaperLink.lookId,
      price: { amountMinor: 80000, currency: 'SEK' },
    });
  });

  it('pages 20 at a time without repeats, in both sorts', async () => {
    const at = (degrees: number) => angled(degrees, 8, 9);
    const base = await piece({ vector: at(0), category: 'sneakers' });
    const made: Piece[] = [];
    for (let i = 0; i < 45; i++) {
      made.push(
        await piece({
          vector: at(1 + i),
          category: 'sneakers',
          // Ties on price, so the distance (then the id) has to break them.
          price: { amountMinor: 10000 * (1 + (i % 7)), currency: 'SEK' },
        }),
      );
    }
    const nearest = await allPages(base.itemId, 'nearest');
    expect(nearest.map((i) => i.productId)).toEqual(made.map((p) => p.productId));

    const cheaper = await allPages(base.itemId, 'cheaper');
    expect(cheaper).toHaveLength(45);
    expect(new Set(cheaper.map((i) => i.productId)).size).toBe(45);
    const prices = cheaper.map((i) => i.price?.amountMinor ?? 0);
    expect(prices).toEqual([...prices].sort((a, b) => a - b));
    const first = await similar(base.itemId, { sort: 'cheaper' });
    expect(first.items).toHaveLength(FEED_PAGE_SIZE);
  });

  it('is 404 for a piece that isn’t shown, and refuses a broken cursor or one of the other sort', async () => {
    const at = (degrees: number) => angled(degrees, 10, 11);
    const pending = await piece({ vector: at(0), category: 'hat', item: 'pending' });
    const gone = await app.inject({
      method: 'GET',
      url: `/v1/look-items/${pending.itemId}/similar`,
    });
    expect(gone.statusCode).toBe(404);
    const unknown = await app.inject({
      method: 'GET',
      url: `/v1/look-items/${crypto.randomUUID()}/similar`,
    });
    expect(unknown.statusCode).toBe(404);

    const base = await piece({ vector: at(0), category: 'hat' });
    for (let i = 0; i < 25; i++) await piece({ vector: at(1 + i), category: 'hat' });
    const { nextCursor } = await similar(base.itemId);
    expect(nextCursor).not.toBeNull();
    const bad = await app.inject({
      method: 'GET',
      url: `/v1/look-items/${base.itemId}/similar?cursor=nope`,
    });
    expect(bad.statusCode).toBe(400);
    const mixed = await app.inject({
      method: 'GET',
      url: `/v1/look-items/${base.itemId}/similar?sort=cheaper&cursor=${encodeURIComponent(nextCursor ?? '')}`,
    });
    expect(mixed.statusCode).toBe(400);
  });
});
