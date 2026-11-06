import { FINGERPRINT_DIMENSIONS, LINK_CHECK_REASONS } from '@outfitly/shared';
import { cosineDistance, eq, sql } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { Db } from '../src/client.ts';
import { runMigrations } from '../src/migrate.ts';
import {
  clicks,
  garments,
  linkChecks,
  lookItems,
  looks,
  media,
  offers,
  products,
} from '../src/schema/index.ts';
import { SEED_PROFILE_IDS, seed } from '../src/seed.ts';
import { createTestDatabase, type TestDatabase, withDb } from './test-database.ts';

let testDb: TestDatabase;

beforeAll(async () => {
  testDb = await createTestDatabase();
  await runMigrations(testDb.url);
  await withDb(testDb.url, seed);
});

afterAll(async () => {
  await testDb.drop();
});

/** A fingerprint pointing along the given axes (e.g. `{ 0: 0.9, 1: 0.1 }`), zero elsewhere. */
function fingerprint(axes: Record<number, number>): number[] {
  const v = new Array<number>(FINGERPRINT_DIMENSIONS).fill(0);
  for (const [axis, value] of Object.entries(axes)) v[Number(axis)] = value;
  return v;
}

/** A Postgres check (23514) or unique (23505) error from the named constraint. */
function refusedBy(constraint: string, code = '23514') {
  return { cause: { code, constraint } };
}

let photoCount = 0;
/** A photo row (status doesn't matter here). */
async function photo(db: Db): Promise<string> {
  photoCount += 1;
  const [row] = await db
    .insert(media)
    .values({
      ownerProfileId: SEED_PROFILE_IDS.creator,
      originalKey: `originals/products-test-${String(photoCount)}`,
    })
    .returning({ id: media.id });
  if (!row) throw new Error('media insert returned no row');
  return row.id;
}

async function look(db: Db): Promise<string> {
  const [row] = await db
    .insert(looks)
    .values({ authorProfileId: SEED_PROFILE_IDS.creator, slug: `look-${crypto.randomUUID()}` })
    .returning({ id: looks.id });
  if (!row) throw new Error('look insert returned no row');
  return row.id;
}

async function offer(db: Db, values: Partial<typeof offers.$inferInsert> = {}): Promise<string> {
  const [product] = await db
    .insert(products)
    .values({ name: 'Wool coat' })
    .returning({ id: products.id });
  if (!product) throw new Error('product insert returned no row');
  const url = `https://shop.example/coat-${crypto.randomUUID()}`;
  const [row] = await db
    .insert(offers)
    .values({ productId: product.id, url, pageUrl: url, ...values })
    .returning({ id: offers.id });
  if (!row) throw new Error('offer insert returned no row');
  return row.id;
}

const BOX = { boxLeft: 0.2, boxTop: 0.1, boxRight: 0.8, boxBottom: 0.6 };

describe('fingerprints', () => {
  it('products and garments: nearest first by cosine distance, answered by the HNSW index', async () => {
    await withDb(testDb.url, async (db) => {
      const mediaId = await photo(db);
      const query = fingerprint({ 0: 1 });
      // Close, in between, far; listed out of order on purpose.
      const shapes = { far: { 1: 1 }, close: { 0: 0.9, 1: 0.1 }, middle: { 0: 0.5, 1: 0.5 } };

      for (const [name, axes] of Object.entries(shapes)) {
        await db.insert(products).values({ name, embedding: fingerprint(axes) });
        await db
          .insert(garments)
          .values({ mediaId, category: 'coat', color: name, ...BOX, embedding: fingerprint(axes) });
      }
      // No fingerprint yet (not fingerprinted): never in the results.
      await db.insert(products).values({ name: 'not fingerprinted' });

      await db.transaction(async (tx) => {
        // A handful of rows would otherwise be read in full; make the planner use the index.
        await tx.execute(sql`SET LOCAL enable_seqscan = off`);

        const nearestProducts = await tx
          .select({ name: products.name, distance: cosineDistance(products.embedding, query) })
          .from(products)
          .where(sql`${products.embedding} is not null`)
          .orderBy(cosineDistance(products.embedding, query))
          .limit(3);
        expect(nearestProducts.map((p) => p.name)).toEqual(['close', 'middle', 'far']);
        expect(nearestProducts[2]?.distance).toBeCloseTo(1, 5); // at right angles

        const nearestGarments = await tx
          .select({ color: garments.color })
          .from(garments)
          .orderBy(cosineDistance(garments.embedding, query))
          .limit(3);
        expect(nearestGarments.map((g) => g.color)).toEqual(['close', 'middle', 'far']);

        for (const [table, index] of [
          ['products', 'products_embedding_idx'],
          ['garments', 'garments_embedding_idx'],
        ] as const) {
          const { rows } = await tx.execute<{ 'QUERY PLAN': string }>(
            sql`EXPLAIN SELECT id FROM ${sql.identifier(table)}
                 ORDER BY embedding <=> ${JSON.stringify(query)} LIMIT 3`,
          );
          expect(rows.map((r) => r['QUERY PLAN']).join('\n')).toContain(
            `Index Scan using ${index}`,
          );
        }
      });
    });
  });

  it('are 768 half-precision numbers; another length is refused', async () => {
    await withDb(testDb.url, async (db) => {
      const { rows } = await db.execute<{ column: string; type: string }>(
        sql`SELECT attrelid::regclass::text || '.' || attname AS column,
                   format_type(atttypid, atttypmod) AS type
              FROM pg_attribute
             WHERE attname = 'embedding' AND attrelid IN ('garments'::regclass, 'products'::regclass)
             ORDER BY 1`,
      );
      expect(rows).toEqual([
        { column: 'garments.embedding', type: 'halfvec(768)' },
        { column: 'products.embedding', type: 'halfvec(768)' },
      ]);
      await expect(
        db.insert(products).values({ name: 'short', embedding: [0.1, 0.2, 0.3] }),
      ).rejects.toMatchObject({ cause: { code: '22000' } });
    });
  });
});

describe('garments', () => {
  it('need a box inside the photo with a size, and a known category', async () => {
    await withDb(testDb.url, async (db) => {
      const mediaId = await photo(db);
      const bad = [
        { ...BOX, boxLeft: -0.1 },
        { ...BOX, boxBottom: 1.2 },
        { ...BOX, boxRight: BOX.boxLeft },
        { ...BOX, boxTop: 0.7 },
      ];
      for (const box of bad) {
        await expect(
          db.insert(garments).values({ mediaId, category: 'jeans', ...box }),
          JSON.stringify(box),
        ).rejects.toMatchObject(refusedBy('garments_box_inside_photo'));
      }
      // The whole photo is a valid box.
      await db.insert(garments).values({
        mediaId,
        category: 'dress',
        boxLeft: 0,
        boxTop: 0,
        boxRight: 1,
        boxBottom: 1,
      });
      await expect(
        db.execute(
          sql`INSERT INTO garments (media_id, category, box_left, box_top, box_right, box_bottom)
              VALUES (${mediaId}, 'cape', 0, 0, 1, 1)`,
        ),
      ).rejects.toMatchObject({ cause: { code: '22P02' } });
      await expect(
        db.execute(
          sql`INSERT INTO garments (media_id, category, box_left, box_top, box_right, box_bottom, attributes)
              VALUES (${mediaId}, 'coat', 0, 0, 1, 1, '[]')`,
        ),
      ).rejects.toMatchObject(refusedBy('garments_attributes_is_object'));
    });
  });

  it('go with their photo; a look item then keeps its offer but loses the garment', async () => {
    await withDb(testDb.url, async (db) => {
      const mediaId = await photo(db);
      const [garment] = await db
        .insert(garments)
        .values({ mediaId, category: 'coat', ...BOX })
        .returning({ id: garments.id });
      const [item] = await db
        .insert(lookItems)
        .values({ lookId: await look(db), offerId: await offer(db), garmentId: garment?.id })
        .returning({ id: lookItems.id });

      await db.delete(media).where(eq(media.id, mediaId));
      expect(await db.$count(garments, eq(garments.mediaId, mediaId))).toBe(0);
      const [after] = await db
        .select()
        .from(lookItems)
        .where(eq(lookItems.id, item?.id ?? ''));
      expect(after).toMatchObject({ garmentId: null, status: 'pending' });
    });
  });
});

describe('products', () => {
  it('need a name; a barcode is 8–14 digits and unique when present', async () => {
    await withDb(testDb.url, async (db) => {
      await expect(db.insert(products).values({ name: '' })).rejects.toMatchObject(
        refusedBy('products_name_length'),
      );
      for (const gtin of ['1234567', '123456789012345', '73100A0000000']) {
        await expect(db.insert(products).values({ name: 'Tee', gtin }), gtin).rejects.toMatchObject(
          refusedBy('products_gtin_format'),
        );
      }
      await db.insert(products).values({ name: 'Tee', gtin: '7310000000001' });
      await expect(
        db.insert(products).values({ name: 'Same tee', gtin: '7310000000001' }),
      ).rejects.toMatchObject(refusedBy('products_gtin_key', '23505'));
      // Many products have no barcode.
      await db.insert(products).values([{ name: 'Scarf' }, { name: 'Belt' }]);
    });
  });

  it("only take a web link as the shop's photo", async () => {
    await withDb(testDb.url, async (db) => {
      await expect(
        db.insert(products).values({ name: 'Bag', imageUrl: 'file:///etc/passwd' }),
      ).rejects.toMatchObject(refusedBy('products_image_url_web'));
      await db
        .insert(products)
        .values({ name: 'Bag', imageUrl: 'https://img.shop.example/bag.jpg' });
    });
  });
});

describe('offers', () => {
  it('have a price with a currency, or neither', async () => {
    await withDb(testDb.url, async (db) => {
      await expect(offer(db, { priceMinor: 49_900 })).rejects.toMatchObject(
        refusedBy('offers_price_has_currency'),
      );
      await expect(offer(db, { currency: 'SEK' })).rejects.toMatchObject(
        refusedBy('offers_price_has_currency'),
      );
      await expect(offer(db, { priceMinor: 49_900, currency: 'sek' })).rejects.toMatchObject(
        refusedBy('offers_currency_format'),
      );
      await expect(offer(db, { priceMinor: -1, currency: 'SEK' })).rejects.toMatchObject(
        refusedBy('offers_price_not_negative'),
      );
      const id = await offer(db, { priceMinor: 49_900, currency: 'SEK' });
      const [row] = await db.select().from(offers).where(eq(offers.id, id));
      expect(row).toMatchObject({ priceMinor: 49_900, currency: 'SEK', stock: 'unknown' });
      expect(row?.priceHistory).toEqual([]);
      await offer(db); // price not known yet
    });
  });

  it('only open web links up to 2 KB, one row per link, with the price history as a list', async () => {
    await withDb(testDb.url, async (db) => {
      await expect(offer(db, { url: 'javascript:alert(1)' })).rejects.toMatchObject(
        refusedBy('offers_url_web'),
      );
      await expect(offer(db, { pageUrl: 'ftp://shop.example/coat' })).rejects.toMatchObject(
        refusedBy('offers_url_web'),
      );
      // A long affiliate deep link fits; longer is refused by name (not by the index's size limit).
      const linkOf = (bytes: number) => {
        const start = 'https://track.example/c?u=';
        return start + 'x'.repeat(bytes - start.length);
      };
      await offer(db, { url: linkOf(2048) });
      await expect(offer(db, { url: linkOf(2049) })).rejects.toMatchObject(
        refusedBy('offers_url_length'),
      );
      await expect(offer(db, { pageUrl: linkOf(3000) })).rejects.toMatchObject(
        refusedBy('offers_url_length'),
      );

      const url = 'https://shop.example/coat?aff=poster123';
      await offer(db, { url });
      await expect(offer(db, { url })).rejects.toMatchObject(refusedBy('offers_url_key', '23505'));

      await expect(
        db.execute(sql`UPDATE offers SET price_history = '{"price": 1}' WHERE url = ${url}`),
      ).rejects.toMatchObject(refusedBy('offers_price_history_is_list'));
    });
  });
});

describe('look items and link checks', () => {
  it('one per look and offer, with a dot inside one photo or none', async () => {
    await withDb(testDb.url, async (db) => {
      const lookId = await look(db);
      const offerId = await offer(db);
      const mediaId = await photo(db);

      await expect(
        db.insert(lookItems).values({ lookId, offerId, mediaId, dotX: 0.5 }),
      ).rejects.toMatchObject(refusedBy('look_items_dot_complete'));
      await expect(
        db.insert(lookItems).values({ lookId, offerId, dotX: 0.5, dotY: 0.5 }),
      ).rejects.toMatchObject(refusedBy('look_items_dot_complete'));
      await expect(
        db.insert(lookItems).values({ lookId, offerId, mediaId, dotX: 1.5, dotY: 0.5 }),
      ).rejects.toMatchObject(refusedBy('look_items_dot_inside_photo'));
      await expect(
        db.insert(lookItems).values({ lookId, offerId, matchScore: 1.2 }),
      ).rejects.toMatchObject(refusedBy('look_items_match_score_range'));

      await db.insert(lookItems).values({ lookId, offerId, mediaId, dotX: 0.5, dotY: 0.25 });
      await expect(db.insert(lookItems).values({ lookId, offerId })).rejects.toMatchObject(
        refusedBy('look_items_look_offer_key', '23505'),
      );
      // An item without a dot (e.g. not visible in the photos) is fine.
      await db.insert(lookItems).values({ lookId, offerId: await offer(db), matchScore: -0.2 });
    });
  });

  it('keep every check; deleting the look takes its items and their checks', async () => {
    await withDb(testDb.url, async (db) => {
      const lookId = await look(db);
      const [item] = await db
        .insert(lookItems)
        .values({ lookId, offerId: await offer(db) })
        .returning({ id: lookItems.id });
      const lookItemId = item?.id ?? '';

      await expect(
        db.insert(linkChecks).values({ lookItemId, similarity: -1.5, outcome: 'rejected' }),
      ).rejects.toMatchObject(refusedBy('link_checks_similarity_range'));
      await db.insert(linkChecks).values([
        { lookItemId, similarity: 0.71, aiAnswer: 'unsure', outcome: 'review' },
        { lookItemId, similarity: 0.93, outcome: 'verified', details: { verifyAt: 0.9 } },
      ]);
      expect(await db.$count(linkChecks, eq(linkChecks.lookItemId, lookItemId))).toBe(2);

      await db.delete(looks).where(eq(looks.id, lookId));
      expect(await db.$count(lookItems, eq(lookItems.lookId, lookId))).toBe(0);
      expect(await db.$count(linkChecks, eq(linkChecks.lookItemId, lookItemId))).toBe(0);
    });
  });
});

describe('link check reasons (Step 3.5)', () => {
  it('the database knows exactly the reasons the app has messages for', async () => {
    await withDb(testDb.url, async (db) => {
      const { rows } = await db.execute<{ def: string }>(
        sql`SELECT pg_get_constraintdef(oid) AS def FROM pg_constraint
             WHERE conname = 'link_checks_reason_known'`,
      );
      const known = [...(rows[0]?.def ?? '').matchAll(/'([a-z_]+)'::text/g)].map((m) => m[1]);
      expect(known.sort()).toEqual([...LINK_CHECK_REASONS].sort());
    });
  });
});

describe('clicks', () => {
  it('need a profile or a logged-out session, and stay even when what they point at is gone', async () => {
    await withDb(testDb.url, async (db) => {
      const base = { offerId: crypto.randomUUID(), platform: 'ios' as const };
      await expect(db.insert(clicks).values(base)).rejects.toMatchObject(
        refusedBy('clicks_has_viewer'),
      );
      await expect(
        db.insert(clicks).values({ ...base, sessionId: crypto.randomUUID(), position: -1 }),
      ).rejects.toMatchObject(refusedBy('clicks_position_not_negative'));

      // Ids of a look and offer that no longer exist: history is kept as it happened.
      const clickId = crypto.randomUUID();
      await db.insert(clicks).values({
        ...base,
        id: clickId,
        profileId: SEED_PROFILE_IDS.personal,
        lookId: crypto.randomUUID(),
        authorProfileId: SEED_PROFILE_IDS.creator,
        position: 7,
        source: 'look',
      });
      expect(await db.$count(clicks, eq(clicks.id, clickId))).toBe(1);
    });
  });
});
