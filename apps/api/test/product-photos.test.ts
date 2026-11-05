import { and, eq, isNull, media, products } from '@outfitly/db';
import type { PgBoss } from 'pg-boss';
import sharp from 'sharp';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  copyProductPhoto,
  fingerprintProduct,
  type ProductPhotoDeps,
} from '../src/links/product-photos.ts';
import { createJobQueue, QUEUES, startJobs } from '../src/jobs.ts';
import { fakeEmbedder } from './ai-fakes.ts';
import { createTestContext, type TestContext } from './helpers.ts';
import { type LocalShop, startLocalShop } from './local-shop.ts';

let ctx: TestContext;
let shop: LocalShop;
let deps: ProductPhotoDeps;
const embedder = fakeEmbedder();

async function photo(color: string): Promise<Buffer> {
  return sharp({ create: { width: 400, height: 600, channels: 3, background: color } })
    .jpeg()
    .toBuffer();
}

async function product(imageUrl: string | null): Promise<string> {
  const [row] = await ctx.db
    .insert(products)
    .values({ name: 'Wool coat', imageUrl })
    .returning({ id: products.id });
  if (!row) throw new Error('no product');
  return row.id;
}

async function productRow(id: string) {
  const [row] = await ctx.db.select().from(products).where(eq(products.id, id));
  return row;
}

beforeAll(async () => {
  ctx = await createTestContext();
  shop = await startLocalShop();
  const red = await photo('#cc2200');
  const blue = await photo('#0033cc');
  shop.route('/red.jpg', (_req, res) =>
    res.writeHead(200, { 'content-type': 'image/jpeg' }).end(red),
  );
  shop.route('/blue.jpg', (_req, res) =>
    res.writeHead(200, { 'content-type': 'application/octet-stream' }).end(blue),
  );
  shop.route('/fake.jpg', (_req, res) =>
    res
      .writeHead(200, { 'content-type': 'image/jpeg' })
      .end('<svg xmlns="http://www.w3.org/2000/svg"/>'),
  );
  shop.route('/page.html', (_req, res) =>
    res.writeHead(200, { 'content-type': 'text/html' }).end('<p>'),
  );
  deps = { db: ctx.db, storage: ctx.storage, embedder: embedder.client, network: shop.network };
});

afterAll(async () => {
  await shop.close();
  await ctx.close();
});

describe('product photos', () => {
  it('copies the shop photo into our storage as an ownerless photo, once', async () => {
    const id = await product(shop.url('/red.jpg'));
    const result = await copyProductPhoto(deps, id);
    expect(result.outcome).toBe('copied');
    const row = await productRow(id);
    const [copy] = await ctx.db
      .select()
      .from(media)
      .where(eq(media.id, row?.imageMediaId ?? ''));
    expect(copy).toMatchObject({
      ownerProfileId: null,
      status: 'ready',
      sourceUrl: shop.url('/red.jpg'),
      width: 400,
      height: 600,
    });
    expect(ctx.storage.publicObjects.has(copy?.key1080 ?? '')).toBe(true);
    expect(ctx.storage.originals.has(`originals/${copy?.id ?? ''}`)).toBe(true);

    const asked = shop.requests.length;
    expect(await copyProductPhoto(deps, id)).toEqual({
      outcome: 'skipped',
      reason: 'already copied',
    });
    expect(shop.requests.length).toBe(asked);
  });

  it('replaces the copy when the shop photo changes, and retires the old one', async () => {
    const id = await product(shop.url('/red.jpg'));
    await copyProductPhoto(deps, id);
    const before = (await productRow(id))?.imageMediaId;
    await ctx.db
      .update(products)
      .set({ imageUrl: shop.url('/blue.jpg') })
      .where(eq(products.id, id));
    expect((await copyProductPhoto(deps, id)).outcome).toBe('copied');
    const after = (await productRow(id))?.imageMediaId;
    expect(after).not.toBe(before);
    const [old] = await ctx.db
      .select()
      .from(media)
      .where(eq(media.id, before ?? ''));
    expect(old?.deletedAt).not.toBeNull();
  });

  it('refuses files that aren’t photos without retrying', async () => {
    const fake = await product(shop.url('/fake.jpg'));
    expect((await copyProductPhoto(deps, fake)).outcome).toBe('refused');
    expect((await productRow(fake))?.imageMediaId).toBeNull();
    const html = await product(shop.url('/page.html'));
    expect((await copyProductPhoto(deps, html)).outcome).toBe('refused');
    const missing = await product(shop.url('/missing.jpg'));
    expect((await copyProductPhoto(deps, missing)).outcome).toBe('refused');
    const internal = await product('http://169.254.169.254/latest/meta-data/photo.jpg');
    expect((await copyProductPhoto(deps, internal)).outcome).toBe('refused');
    expect(await copyProductPhoto(deps, await product(null))).toEqual({
      outcome: 'skipped',
      reason: 'no shop photo',
    });
  });

  it('fingerprints the copied photo, from our own storage', async () => {
    const id = await product(shop.url('/red.jpg'));
    await copyProductPhoto(deps, id);
    const calls = embedder.calls.length;
    expect(await fingerprintProduct(deps, id)).toEqual({
      outcome: 'done',
      model: 'Marqo/marqo-fashionSigLIP@c56244c',
    });
    const row = await productRow(id);
    expect(row?.embeddingModel).toBe('Marqo/marqo-fashionSigLIP@c56244c');
    expect(row?.embedding).toHaveLength(768);
    const call = embedder.calls[calls];
    expect((call?.body as { url: string }).url).toMatch(/^https:\/\/img\.test\/m\//);
    expect(await fingerprintProduct(deps, id)).toEqual({
      outcome: 'skipped',
      reason: 'already fingerprinted',
    });
    // A new copy clears the old fingerprint.
    await ctx.db
      .update(products)
      .set({ imageUrl: shop.url('/blue.jpg') })
      .where(eq(products.id, id));
    await copyProductPhoto(deps, id);
    expect((await productRow(id))?.embedding).toBeNull();
  });

  it('leaves a product without a copied photo alone', async () => {
    const id = await product(shop.url('/red.jpg'));
    expect(await fingerprintProduct(deps, id)).toEqual({
      outcome: 'skipped',
      reason: 'photo not ready',
    });
    const live = await ctx.db
      .select({ id: media.id })
      .from(media)
      .where(and(isNull(media.ownerProfileId), isNull(media.deletedAt)));
    expect(live.length).toBeGreaterThan(0);
  });
});

describe('product photo jobs', () => {
  let boss: PgBoss;

  beforeAll(async () => {
    boss = createJobQueue(ctx.testDb.url);
    const quiet = { info: () => undefined, error: () => undefined };
    await startJobs(boss, {
      db: ctx.db,
      storage: ctx.storage,
      log: quiet as unknown as Parameters<typeof startJobs>[1]['log'],
      pollingIntervalSeconds: 0.5,
      ai: { gemini: null, embedder: embedder.client, dailyCapMicros: 1 },
      aiRetryDelaySeconds: 0,
      linkNetwork: shop.network,
    });
  });

  afterAll(async () => {
    await boss.stop({ graceful: false, close: true });
  });

  it('copy the photo, then fingerprint it', async () => {
    const id = await product(shop.url('/red.jpg'));
    await boss.send(QUEUES.productPhoto, { productId: id }, { singletonKey: id });
    await expect
      .poll(async () => (await productRow(id))?.embeddingModel ?? null, { timeout: 15_000 })
      .toBe('Marqo/marqo-fashionSigLIP@c56244c');
  });
});
