import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { and, eq, isNull, lookItems, offers, sql } from '@outfitly/db';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { placeholderPhoto } from '../scripts/seed/fake-looks.ts';
import { seedLookItems, type SeedItemsOptions } from '../scripts/seed/items.ts';
import { seedLookId, seedLooks, seedPhotoId } from '../scripts/seed/looks.ts';
import {
  COAT_AND_SNEAKERS,
  fakeEmbedder,
  fakeGemini,
  geminiResponse,
  json,
  unitVector,
} from './ai-fakes.ts';
import { createTestContext, type TestContext } from './helpers.ts';
import { type LocalShop, startLocalShop } from './local-shop.ts';

let ctx: TestContext;
let shop: LocalShop;
let folder: string;

function productPage(name: string, image: string): string {
  return `<!doctype html><html><head><script type="application/ld+json">
{"@context":"https://schema.org","@type":"Product","name":"${name}","brand":"Filippa K",
 "image":"${image}","offers":{"@type":"Offer","price":"2499.00","priceCurrency":"SEK",
 "availability":"https://schema.org/InStock"}}
</script></head><body></body></html>`;
}

beforeAll(async () => {
  ctx = await createTestContext();
  shop = await startLocalShop();
  const coatPhoto = await placeholderPhoto(5, 200);
  shop.route('/coat.jpg', (_req, res) =>
    res.writeHead(200, { 'content-type': 'image/jpeg' }).end(coatPhoto),
  );
  shop.route('/p/coat', (_req, res) =>
    res
      .writeHead(200, { 'content-type': 'text/html' })
      .end(productPage('Wool coat', shop.url('/coat.jpg'))),
  );
  folder = await mkdtemp(join(tmpdir(), 'outfitly-seed-items-'));
  await writeFile(join(folder, 'look.jpg'), await placeholderPhoto(1, 300));
  await writeFile(join(folder, 'other.jpg'), await placeholderPhoto(2, 300));
});

afterAll(async () => {
  await shop.close();
  await ctx.close();
  await rm(folder, { recursive: true, force: true });
});

async function writeLooks(entries: unknown[]): Promise<void> {
  await writeFile(join(folder, 'looks.json'), JSON.stringify(entries));
}

/** Gemini reading the photo (a coat and sneakers) and saying "same" when asked to compare. */
function gemini() {
  return fakeGemini((call) => {
    const text = JSON.stringify(call.body);
    return geminiResponse(
      text.includes('Photo A') ? { same: 'yes', reason: 'Same coat.' } : COAT_AND_SNEAKERS,
    );
  });
}

function options(overrides: Partial<SeedItemsOptions> = {}): SeedItemsOptions {
  // Every box gets the same fingerprint: the coat is (very) like the product.
  const embedder = fakeEmbedder((call) => {
    const { boxes } = call.body as { boxes: unknown[] };
    return json({
      model: 'Marqo/marqo-fashionSigLIP@c56244c',
      embeddings: boxes.map(() => unitVector(0)),
      timing: { downloadMs: 1, inferenceMs: 1 },
    });
  });
  return {
    db: ctx.db,
    storage: ctx.storage,
    folder,
    gemini: gemini().client,
    embedder: embedder.client,
    dailyCapMicros: 5_000_000,
    network: shop.network,
    minGapMs: 0,
    ...overrides,
  };
}

describe('pnpm seed:items (the seed looks’ shop links)', () => {
  it('adds each link as a look item, reads the photo, and checks it', async () => {
    await writeLooks([
      {
        photos: ['look.jpg'],
        tags: [],
        author: 'seed.items',
        links: [shop.url('/p/coat?aff=elias'), shop.url('/p/gone')],
      },
    ]);
    await seedLooks({ db: ctx.db, storage: ctx.storage, folder });
    const lookId = seedLookId(await seedPhotoId(folder, 'look.jpg'));

    const result = await seedLookItems(options());
    expect(result.rows).toEqual([
      expect.objectContaining({
        look: 'look.jpg',
        product: 'Wool coat',
        outcome: 'verified',
        reason: null,
      }),
      expect.objectContaining({ outcome: 'problem', reason: 'link: not_found' }),
    ]);
    expect(result.rows[0]?.similarity).toBeCloseTo(1, 2);
    expect(result.costMicros).toBeGreaterThan(0);
    const items = await ctx.db
      .select()
      .from(lookItems)
      .where(and(eq(lookItems.lookId, lookId), isNull(lookItems.deletedAt)));
    expect(items).toHaveLength(1);
    expect(items[0]?.status).toBe('verified');
    expect(items[0]?.matchedGarmentId).not.toBeNull();

    // Again: nothing new, and the earlier decision is reported.
    const again = await seedLookItems(options());
    expect(again.rows[0]).toMatchObject({ outcome: 'verified', product: 'Wool coat' });
    expect(
      await ctx.db
        .select()
        .from(lookItems)
        .where(and(eq(lookItems.lookId, lookId), isNull(lookItems.deletedAt))),
    ).toHaveLength(1);

    // The shop is down for a run: the link keeps its item.
    shop.route('/p/coat', (_req, res) => res.writeHead(503).end());
    await ctx.db.update(offers).set({ lastCheckedAt: sql`now() - interval '2 hours'` });
    const down = await seedLookItems(options());
    expect(down.rows[0]).toMatchObject({ outcome: 'problem', reason: 'link: blocked' });
    expect(down.removed).toBe(0);
    shop.route('/p/coat', (_req, res) =>
      res
        .writeHead(200, { 'content-type': 'text/html' })
        .end(productPage('Wool coat', shop.url('/coat.jpg'))),
    );

    // A link taken out of the file comes off the look.
    await writeLooks([{ photos: ['look.jpg'], tags: [], author: 'seed.items', links: [] }]);
    const removed = await seedLookItems(options());
    expect(removed.removed).toBe(1);
  });

  it('leaves looks without links alone and says when a look isn’t loaded', async () => {
    await writeLooks([
      { photos: ['look.jpg'], tags: [], author: 'seed.items' },
      { photos: ['other.jpg'], tags: [], author: 'seed.items', links: [shop.url('/p/coat')] },
    ]);
    const result = await seedLookItems(options());
    expect(result.rows).toEqual([
      expect.objectContaining({
        look: 'other.jpg',
        outcome: 'problem',
        reason: 'look not loaded (run pnpm seed:looks first)',
      }),
    ]);
  });

  it('without Gemini, an unread look waits', async () => {
    await writeFile(join(folder, 'third.jpg'), await placeholderPhoto(3, 300));
    await writeLooks([
      { photos: ['third.jpg'], tags: [], author: 'seed.items', links: [shop.url('/p/coat')] },
    ]);
    await seedLooks({ db: ctx.db, storage: ctx.storage, folder });
    const result = await seedLookItems(options({ gemini: null }));
    expect(result.rows[0]).toMatchObject({ outcome: 'waiting', reason: 'photo not read' });
  });
});
