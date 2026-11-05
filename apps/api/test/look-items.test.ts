import {
  boardItems,
  boards,
  garments,
  lookItems,
  lookMedia,
  media,
  offers,
  products,
  sql,
} from '@outfitly/db';
import {
  boardListSchema,
  feedPageSchema,
  type GarmentCategory,
  lookDetailSchema,
  MAX_LOOK_ITEMS,
  meSchema,
  type OfferStock,
} from '@outfitly/shared';
import type { FastifyInstance } from 'fastify';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { lookDetail } from '../src/looks.ts';
import { listBoards } from '../src/saves.ts';
import {
  addShopTestLook,
  pickTestLook,
  removeShopTestPieces,
} from '../scripts/seed/shop-test-look.ts';
import { createAuthor, createLogin, createLook } from './feed-fixtures.ts';
import { buildTestApp, createTestContext, type TestContext } from './helpers.ts';

let ctx: TestContext;
let app: FastifyInstance;
let author: string;

beforeAll(async () => {
  ctx = await createTestContext();
  app = await buildTestApp(ctx);
  await app.ready();
  author = await createAuthor(ctx.db, 'items.author');
});

afterAll(async () => {
  await app.close();
  await ctx.close();
});

const readyPhoto = (id: string, extra: Partial<typeof media.$inferInsert> = {}) => ({
  id,
  status: 'ready' as const,
  originalKey: `originals/${id}`,
  key1080: `m/${id}/1080.webp`,
  key600: `m/${id}/600.webp`,
  key300: `m/${id}/300.webp`,
  width: 800,
  height: 1200,
  thumbhash: 'k0oGLQaSVsN0BVhn2oq2Z5SQUQcZ',
  dominantColor: '#c0b0a0',
  ...extra,
});

/** The look's photo at `position` (the cover is 0, made with the look). */
async function photoAt(lookId: string, position: number): Promise<string> {
  if (position > 0) {
    const id = crypto.randomUUID();
    await ctx.db.insert(media).values(readyPhoto(id, { ownerProfileId: author }));
    await ctx.db.insert(lookMedia).values({ lookId, mediaId: id, position });
    return id;
  }
  const { rows } = await ctx.db.execute<{ media_id: string }>(
    sql`SELECT media_id FROM look_media WHERE look_id = ${lookId} AND position = 0`,
  );
  const id = rows[0]?.media_id;
  if (!id) throw new Error('no cover');
  return id;
}

interface ProductSpec {
  name?: string;
  brand?: string | null;
  category?: GarmentCategory | null;
  price?: { amountMinor: number; currency: string } | null;
  stock?: OfferStock;
  photo?: boolean;
  url?: string;
  pageUrl?: string;
}

/** A product with its photo (unless `photo: false`) and one shop link. Returns the offer id. */
async function shopLink(spec: ProductSpec = {}): Promise<string> {
  const productId = crypto.randomUUID();
  let imageMediaId: string | null = null;
  if (spec.photo !== false) {
    imageMediaId = crypto.randomUUID();
    await ctx.db
      .insert(media)
      .values(readyPhoto(imageMediaId, { sourceUrl: 'https://shop.test/p.jpg' }));
  }
  await ctx.db.insert(products).values({
    id: productId,
    name: spec.name ?? 'Wool coat',
    brand: spec.brand === undefined ? 'Acme' : spec.brand,
    category: spec.category ?? null,
    imageMediaId,
  });
  const id = crypto.randomUUID();
  const price = spec.price === undefined ? { amountMinor: 129900, currency: 'SEK' } : spec.price;
  await ctx.db.insert(offers).values({
    id,
    productId,
    url: spec.url ?? `https://www.shop.test/p/${id}?aff=poster`,
    pageUrl: spec.pageUrl ?? `https://www.shop.test/p/${id}`,
    priceMinor: price?.amountMinor ?? null,
    currency: price?.currency ?? null,
    stock: spec.stock ?? 'in_stock',
    lastCheckedAt: new Date('2026-11-05T08:00:00Z'),
  });
  return id;
}

/** One more shop link to the same product as `offerId` (e.g. another poster's affiliate link). */
async function sameProduct(
  offerId: string,
  price: { amountMinor: number; currency: string },
  stock: OfferStock = 'in_stock',
): Promise<string> {
  const id = crypto.randomUUID();
  await ctx.db.execute(sql`
    INSERT INTO offers (id, product_id, url, page_url, price_minor, currency, stock)
    SELECT ${id}, product_id, url || '&other=' || ${id}, page_url, ${price.amountMinor},
           ${price.currency}, ${stock}
      FROM offers WHERE id = ${offerId}`);
  return id;
}

async function garment(
  mediaId: string,
  category: GarmentCategory,
  box: [number, number, number, number],
): Promise<string> {
  const id = crypto.randomUUID();
  const [boxLeft, boxTop, boxRight, boxBottom] = box;
  await ctx.db.insert(garments).values({
    id,
    mediaId,
    category,
    boxLeft,
    boxTop,
    boxRight,
    boxBottom,
  });
  return id;
}

async function item(
  lookId: string,
  offerId: string,
  extra: Partial<typeof lookItems.$inferInsert> = {},
): Promise<string> {
  const id = crypto.randomUUID();
  await ctx.db.insert(lookItems).values({ id, lookId, offerId, status: 'verified', ...extra });
  return id;
}

async function detailOf(lookId: string) {
  const res = await app.inject({ method: 'GET', url: `/v1/looks/${lookId}` });
  expect(res.statusCode, res.body).toBe(200);
  return lookDetailSchema.parse(res.json());
}

describe('the look page lists its pieces', () => {
  it('shows only verified pieces whose link and product are still there', async () => {
    const look = await createLook(ctx.db, { authorId: author });
    const shown = await item(look, await shopLink({ name: 'Shown' }));
    for (const status of ['pending', 'review', 'rejected'] as const) {
      await item(look, await shopLink({ name: status }), { status });
    }
    await item(look, await shopLink({ name: 'Removed' }), { deletedAt: new Date() });
    const goneLink = await shopLink({ name: 'Link gone' });
    await item(look, goneLink);
    await ctx.db.execute(sql`UPDATE offers SET deleted_at = now() WHERE id = ${goneLink}`);
    const goneProduct = await shopLink({ name: 'Product gone' });
    await item(look, goneProduct);
    await ctx.db.execute(sql`
      UPDATE products SET deleted_at = now()
       WHERE id = (SELECT product_id FROM offers WHERE id = ${goneProduct})`);

    const detail = await detailOf(look);
    expect(detail.items.map((i) => i.id)).toEqual([shown]);
    expect(detail.itemCount).toBe(1);
  });

  it('gives each piece its product, price, stock, shop and link as posted', async () => {
    const look = await createLook(ctx.db, { authorId: author });
    const offer = await shopLink({
      name: 'Camel coat',
      brand: 'Acme',
      category: 'coat',
      price: { amountMinor: 39950, currency: 'SEK' },
      stock: 'unknown',
      url: 'https://www.zalando.test/coat?utm_source=x&aff=poster',
      pageUrl: 'https://www.zalando.test/coat',
    });
    await item(look, offer);
    const noPhoto = await shopLink({ name: 'No photo', photo: false, price: null });
    await item(look, noPhoto);

    const [coat, bare] = (await detailOf(look)).items;
    expect(coat).toMatchObject({
      offerId: offer,
      name: 'Camel coat',
      brand: 'Acme',
      category: 'coat',
      price: { amountMinor: 39950, currency: 'SEK' },
      stock: 'unknown',
      priceCheckedAt: '2026-11-05T08:00:00.000Z',
      url: 'https://www.zalando.test/coat?utm_source=x&aff=poster',
      shop: 'zalando.test',
    });
    // Our copy of the shop's photo, never the shop's own link.
    expect(coat?.image?.urls[300]).toMatch(/^https:\/\/img\.test\/m\/.+\/300\.webp$/);
    expect(bare).toMatchObject({ name: 'No photo', image: null, price: null });
  });

  it('shows a price of 0 as no price', async () => {
    const look = await createLook(ctx.db, { authorId: author });
    await item(look, await shopLink({ price: { amountMinor: 0, currency: 'SEK' } }));
    expect((await detailOf(look)).items[0]?.price).toBeNull();
  });

  it("puts the dot where the poster put it, else on the matched piece, else the poster's pick", async () => {
    const look = await createLook(ctx.db, { authorId: author });
    const cover = await photoAt(look, 0);
    const second = await photoAt(look, 1);
    const coat = await garment(cover, 'coat', [0.2, 0.1, 0.6, 0.5]);
    const bag = await garment(second, 'bag', [0.6, 0.6, 0.8, 1]);
    const goneGarment = await garment(cover, 'jeans', [0.3, 0.5, 0.7, 0.9]);
    await ctx.db.execute(sql`UPDATE garments SET deleted_at = now() WHERE id = ${goneGarment}`);

    const own = await item(look, await shopLink({ category: 'coat' }), {
      mediaId: second,
      dotX: 0.25,
      dotY: 0.75,
      matchedGarmentId: coat,
    });
    const matched = await item(look, await shopLink({ category: 'bag' }), {
      matchedGarmentId: bag,
    });
    // Its matched piece was replaced by a new reading: the poster's pick is next.
    const picked = await item(look, await shopLink({ category: 'jeans' }), {
      matchedGarmentId: goneGarment,
      garmentId: coat,
    });
    const nowhere = await item(look, await shopLink({ category: 'belt' }), {
      matchedGarmentId: goneGarment,
    });
    // A dot on a photo that isn't one of the look's (shown) photos counts as none.
    const strayPhoto = crypto.randomUUID();
    await ctx.db.insert(media).values(readyPhoto(strayPhoto, { ownerProfileId: author }));
    const stray = await item(look, await shopLink({ category: 'hat' }), {
      mediaId: strayPhoto,
      dotX: 0.5,
      dotY: 0.5,
    });

    const dots = new Map((await detailOf(look)).items.map((i) => [i.id, i.dot]));
    expect(dots.get(own)).toEqual({ photo: 1, x: 0.25, y: 0.75 });
    expect(dots.get(matched)?.photo).toBe(1);
    expect(dots.get(matched)?.x).toBeCloseTo(0.7);
    expect(dots.get(matched)?.y).toBeCloseTo(0.8);
    expect(dots.get(picked)?.photo).toBe(0);
    expect(dots.get(picked)?.x).toBeCloseTo(0.4);
    expect(dots.get(picked)?.y).toBeCloseTo(0.3);
    expect(dots.get(nowhere)).toBeNull();
    expect(dots.get(stray)).toBeNull();
  });

  it('lists pieces outerwear first and accessories last, then top to bottom', async () => {
    const look = await createLook(ctx.db, { authorId: author });
    const cover = await photoAt(look, 0);
    const bag = await item(look, await shopLink({ category: 'bag' }));
    const unknown = await item(look, await shopLink({ category: null }));
    const lowShoe = await item(look, await shopLink({ category: 'boots' }), {
      mediaId: cover,
      dotX: 0.5,
      dotY: 0.95,
    });
    const coat = await item(look, await shopLink({ category: 'coat' }));
    const highShoe = await item(look, await shopLink({ category: 'boots' }), {
      mediaId: cover,
      dotX: 0.4,
      dotY: 0.9,
    });
    // No product category: the piece the check matched says what it is.
    const jeansGarment = await garment(cover, 'jeans', [0.3, 0.5, 0.7, 0.9]);
    const jeans = await item(look, await shopLink({ category: null }), {
      matchedGarmentId: jeansGarment,
    });

    const detail = await detailOf(look);
    expect(detail.items.map((i) => i.id)).toEqual([coat, jeans, highShoe, lowShoe, bag, unknown]);
    expect(detail.items[1]?.category).toBe('jeans');
  });

  it(`shows at most ${String(MAX_LOOK_ITEMS)} pieces, in four queries however many there are`, async () => {
    const empty = await createLook(ctx.db, { authorId: author });
    const full = await createLook(ctx.db, { authorId: author });
    for (let i = 0; i < MAX_LOOK_ITEMS + 2; i += 1) await item(full, await shopLink());

    const deps = { db: ctx.db, storage: ctx.storage };
    const execute = vi.spyOn(ctx.db, 'execute');
    try {
      expect((await lookDetail(deps, null, empty)).items).toHaveLength(0);
      expect(execute).toHaveBeenCalledTimes(4);
      execute.mockClear();
      const detail = await lookDetail(deps, null, full);
      expect(detail.items).toHaveLength(MAX_LOOK_ITEMS);
      expect(detail.itemCount).toBe(MAX_LOOK_ITEMS);
      expect(execute).toHaveBeenCalledTimes(4);
    } finally {
      execute.mockRestore();
    }
  });
});

describe('feed cards count the pieces', () => {
  it('counts the pieces the look page shows', async () => {
    const look = await createLook(ctx.db, {
      authorId: author,
      caption: 'Counted pieces',
      hoursAgo: 1,
    });
    await item(look, await shopLink());
    await item(look, await shopLink());
    await item(look, await shopLink(), { status: 'pending' });

    const similarTo = await createLook(ctx.db, { authorId: author, hoursAgo: 1 });
    const res = await app.inject({ method: 'GET', url: `/v1/looks/${similarTo}/similar` });
    const page = feedPageSchema.parse(res.json());
    expect(page.items.find((c) => c.id === look)?.itemCount).toBe(2);
    expect((await detailOf(look)).itemCount).toBe(2);
  });
});

describe('board totals', () => {
  async function boardWith(profileId: string, looksOnIt: string[]): Promise<string> {
    const id = crypto.randomUUID();
    await ctx.db.insert(boards).values({ id, profileId, name: `Board ${id.slice(0, 4)}` });
    for (const lookId of looksOnIt) await ctx.db.insert(boardItems).values({ boardId: id, lookId });
    return id;
  }

  async function profile(): Promise<string> {
    const { token } = await createLogin(ctx.db);
    const res = await app.inject({
      method: 'POST',
      url: '/v1/session',
      headers: { authorization: `Bearer ${token}`, 'idempotency-key': crypto.randomUUID() },
      payload: {},
    });
    const me = meSchema.parse(res.json());
    if (!me.activeProfileId) throw new Error('no active profile');
    return me.activeProfileId;
  }

  it('adds up the pieces of its looks per currency, each product once', async () => {
    const owner = await profile();
    const first = await createLook(ctx.db, { authorId: author });
    const second = await createLook(ctx.db, { authorId: author });
    const coat = await shopLink({ price: { amountMinor: 139900, currency: 'SEK' } });
    await item(first, coat);
    await item(second, coat); // the same coat in both looks counts once…
    // …and so does the same coat through another poster's link: at its lowest price.
    await item(second, await sameProduct(coat, { amountMinor: 129900, currency: 'SEK' }));
    await item(first, await shopLink({ price: { amountMinor: 59950, currency: 'SEK' } }));
    await item(second, await shopLink({ price: { amountMinor: 4500, currency: 'EUR' } }));
    // Left out: sold out, no price, not verified.
    await item(
      first,
      await shopLink({ price: { amountMinor: 99900, currency: 'SEK' }, stock: 'out_of_stock' }),
    );
    await item(second, await shopLink({ price: null }));
    await item(first, await shopLink({ price: { amountMinor: 100, currency: 'SEK' } }), {
      status: 'pending',
    });
    // A hidden look on the board doesn't count either.
    const hidden = await createLook(ctx.db, { authorId: author, status: 'hidden' });
    await item(hidden, await shopLink({ price: { amountMinor: 5000, currency: 'SEK' } }));

    const board = await boardWith(owner, [first, second, hidden]);
    const empty = await boardWith(owner, []);
    const all = await listBoards({ db: ctx.db, storage: ctx.storage }, owner);
    boardListSchema.parse({ items: all });
    const byId = new Map(all.map((b) => [b.id, b]));
    expect(byId.get(board)?.totals).toEqual([
      { amountMinor: 189850, currency: 'SEK' },
      { amountMinor: 4500, currency: 'EUR' },
    ]);
    expect(byId.get(empty)?.totals).toEqual([]);
  });

  it("counts each look's shown pieces only, and only looks already out", async () => {
    const owner = await profile();
    const full = await createLook(ctx.db, { authorId: author });
    for (let i = 0; i < MAX_LOOK_ITEMS + 2; i += 1) {
      await item(full, await shopLink({ price: { amountMinor: 100, currency: 'SEK' } }));
    }
    // Not out yet (published in the future): its look page is a 404, so it isn't counted.
    const later = await createLook(ctx.db, { authorId: author, hoursAgo: -2 });
    await item(later, await shopLink({ price: { amountMinor: 5000, currency: 'SEK' } }));
    // A price of 0 is no price.
    await item(full, await shopLink({ price: { amountMinor: 0, currency: 'SEK' } }));

    const board = await boardWith(owner, [full, later]);
    const all = await listBoards({ db: ctx.db, storage: ctx.storage }, owner);
    expect(all.find((b) => b.id === board)?.totals).toEqual([
      { amountMinor: 100 * MAX_LOOK_ITEMS, currency: 'SEK' },
    ]);
  });

  it('leaves totals out for the "Save to board" sheet', async () => {
    const owner = await profile();
    const look = await createLook(ctx.db, { authorId: author });
    await item(look, await shopLink());
    const board = await boardWith(owner, [look]);
    const deps = { db: ctx.db, storage: ctx.storage };
    const [forSheet] = await listBoards(deps, owner, look);
    expect(forSheet).toMatchObject({ id: board, hasLook: true });
    expect(forSheet).not.toHaveProperty('totals');
    const [forSaved] = await listBoards(deps, owner);
    expect(forSaved?.totals).toEqual([{ amountMinor: 129900, currency: 'SEK' }]);
  });
});

describe('the shop test look (pnpm shop:test-look)', () => {
  it('adds five test pieces as the Maestro flow expects, and removes only those', async () => {
    const look = await createLook(ctx.db, { authorId: author });
    const real = await item(look, await shopLink({ name: 'Real piece', category: 'hat' }));
    expect(await pickTestLook(ctx.db, look)).toBe(look);

    expect(await addShopTestLook(ctx.db, look)).toBe(5);
    // Twice changes nothing: the earlier test pieces go first.
    expect(await addShopTestLook(ctx.db, look)).toBe(5);
    const detail = await detailOf(look);
    expect(detail.items.map((i) => [i.name, i.stock, i.price?.amountMinor ?? null])).toEqual([
      ['Test coat', 'in_stock', 129900],
      ['Test knit', 'unknown', 49950],
      ['Test jeans', 'in_stock', 59900],
      ['Test sneakers (sold out)', 'out_of_stock', 89900],
      ['Test bag (no price)', 'in_stock', null],
      ['Real piece', 'in_stock', 129900], // a hat: after bags
    ]);
    expect(detail.items.filter((i) => i.dot !== null)).toHaveLength(5);

    expect(await removeShopTestPieces(ctx.db)).toBe(5);
    expect((await detailOf(look)).items.map((i) => i.id)).toEqual([real]);
    const { rows } = await ctx.db.execute<{ n: number }>(
      sql`SELECT count(*)::int AS n FROM products WHERE brand = 'Outfitly test'`,
    );
    expect(rows[0]?.n).toBe(0);
  });
});
