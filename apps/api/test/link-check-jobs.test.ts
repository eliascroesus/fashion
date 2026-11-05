import { aiCalls, eq, garments, lookItems, lookMedia, media, offers, products } from '@outfitly/db';
import type { PgBoss } from 'pg-boss';
import sharp from 'sharp';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { nextUtcDay } from '../src/ai/photos.ts';
import { createJobQueue, QUEUES, startJobs } from '../src/jobs.ts';
import { addLookItem } from '../src/links/check.ts';
import { fakeEmbedder, fakeGemini, geminiResponse, json, unitVector } from './ai-fakes.ts';
import { createAuthor, createLook } from './feed-fixtures.ts';
import { createTestContext, type TestContext } from './helpers.ts';

const MODEL = 'Marqo/marqo-fashionSigLIP@c56244c';
let ctx: TestContext;
let boss: PgBoss;
let authorId: string;
const logged: unknown[] = [];
const log = {
  info: (obj: unknown) => logged.push(obj),
  error: (obj: unknown, msg?: string) => logged.push({ ...(obj as object), msg }),
} as unknown as Parameters<typeof startJobs>[1]['log'];

/** What Gemini answers when asked to compare. */
let answer: unknown = { same: 'yes', reason: 'Same coat.' };
const gemini = fakeGemini(() => geminiResponse(answer));
// Every box gets the same fingerprint: a freshly fingerprinted piece and product are alike.
const embedder = fakeEmbedder((call) => {
  const { boxes } = call.body as { boxes: unknown[] };
  return json({
    model: MODEL,
    embeddings: boxes.map(() => unitVector(0)),
    timing: { downloadMs: 1, inferenceMs: 1 },
  });
});

beforeAll(async () => {
  ctx = await createTestContext();
  authorId = await createAuthor(ctx.db, 'job.linkchecker');
  boss = createJobQueue(ctx.testDb.url);
  await startJobs(boss, {
    db: ctx.db,
    storage: ctx.storage,
    log,
    pollingIntervalSeconds: 0.5,
    ai: { gemini: gemini.client, embedder: embedder.client, dailyCapMicros: 5_000_000 },
    aiRetryDelaySeconds: 0,
  });
});

afterAll(async () => {
  await boss.stop({ graceful: false, close: true });
  await ctx.close();
});

beforeEach(async () => {
  await ctx.db.delete(aiCalls);
  answer = { same: 'yes', reason: 'Same coat.' };
});

/** A fingerprint at `similarity` to unitVector(0). */
function alike(similarity: number): number[] {
  const v = unitVector(0).map((x) => x * similarity);
  v[1] = Math.sqrt(1 - similarity * similarity);
  return v;
}

/**
 * A read look photo with one garment, a product with a copied photo and an
 * offer; fingerprints given or missing (null).
 */
async function setup(garment: number[] | null, product: number[] | null) {
  const lookId = await createLook(ctx.db, { authorId });
  const [link] = await ctx.db
    .select({ mediaId: lookMedia.mediaId })
    .from(lookMedia)
    .where(eq(lookMedia.lookId, lookId));
  const mediaId = link?.mediaId ?? '';
  const webp = await sharp({
    create: { width: 60, height: 80, channels: 3, background: '#a08870' },
  })
    .webp()
    .toBuffer();
  await ctx.storage.putPublic(`m/${mediaId}/1080.webp`, webp, 'image/webp');
  await ctx.db
    .update(media)
    .set({ spotStatus: 'done', embedding: unitVector(3), embeddingModel: MODEL })
    .where(eq(media.id, mediaId));
  await ctx.db.insert(garments).values({
    mediaId,
    category: 'coat',
    boxLeft: 0.1,
    boxTop: 0.1,
    boxRight: 0.9,
    boxBottom: 0.6,
    embedding: garment,
    embeddingModel: garment ? MODEL : null,
  });
  const photoId = crypto.randomUUID();
  await ctx.db.insert(media).values({
    id: photoId,
    ownerProfileId: null,
    sourceUrl: `https://shop.test/${photoId}.jpg`,
    status: 'ready',
    originalKey: `originals/${photoId}`,
    key1080: `m/${photoId}/1080.webp`,
    key600: `m/${photoId}/600.webp`,
    key300: `m/${photoId}/300.webp`,
    width: 60,
    height: 80,
    thumbhash: 'k0oGLQaSVsN0BVhn2oq2Z5SQUQcZ',
    dominantColor: '#a08870',
  });
  await ctx.storage.putPublic(`m/${photoId}/1080.webp`, webp, 'image/webp');
  const [row] = await ctx.db
    .insert(products)
    .values({
      name: 'Coat',
      imageUrl: `https://shop.test/${photoId}.jpg`,
      imageMediaId: photoId,
      embedding: product,
      embeddingModel: product ? MODEL : null,
    })
    .returning({ id: products.id });
  const productId = row?.id ?? '';
  const [offer] = await ctx.db
    .insert(offers)
    .values({
      productId,
      url: `https://shop.test/p/${crypto.randomUUID()}`,
      pageUrl: 'https://shop.test/p',
      stock: 'in_stock',
      lastCheckedAt: new Date(),
    })
    .returning({ id: offers.id });
  const { id } = await addLookItem(ctx.db, boss, { lookId, offerId: offer?.id ?? '' });
  return { lookId, mediaId, productId, id };
}

async function statusOf(id: string) {
  return (
    await ctx.db.select({ s: lookItems.status }).from(lookItems).where(eq(lookItems.id, id))
  )[0]?.s;
}

describe('link check jobs', () => {
  it('a queued check decides the item (one job per item at a time)', async () => {
    expect((await boss.getQueue(QUEUES.linkCheck))?.policy).toBe('stately');
    const { id } = await setup(alike(0.95), unitVector(0));
    await expect.poll(() => statusOf(id), { timeout: 15_000 }).toBe('verified');
  });

  it('asks the AI in between', async () => {
    const { id } = await setup(alike(0.7), unitVector(0));
    await expect.poll(() => statusOf(id), { timeout: 15_000 }).toBe('verified');
    const calls = await ctx.db.select().from(aiCalls).where(eq(aiCalls.lookItemId, id));
    expect(calls.map((c) => c.purpose)).toEqual(['link_check']);
  });

  it('checks an item waiting for its product’s fingerprint once that is made', async () => {
    const { id, productId } = await setup(unitVector(0), null);
    await expect.poll(() => statusOf(id), { timeout: 10_000 }).toBe('pending');
    await boss.send(QUEUES.productFingerprint, { productId }, { singletonKey: productId });
    await expect.poll(() => statusOf(id), { timeout: 15_000 }).toBe('verified');
  });

  it('checks an item waiting for its garment’s fingerprint once that is made', async () => {
    const { id, mediaId } = await setup(null, unitVector(0));
    await expect.poll(() => statusOf(id), { timeout: 10_000 }).toBe('pending');
    await boss.send(QUEUES.photoFingerprint, { mediaId }, { singletonKey: mediaId });
    await expect.poll(() => statusOf(id), { timeout: 15_000 }).toBe('verified');
  });

  it('an unusable paid answer isn’t retried by the queue (the sweep asks again later)', async () => {
    answer = { maybe: true };
    const { id } = await setup(alike(0.7), unitVector(0));
    await expect
      .poll(
        async () =>
          (await boss.findJobs(QUEUES.linkCheck, { key: id })).every(
            (j) => j.state === 'completed',
          ),
        { timeout: 15_000 },
      )
      .toBe(true);
    const calls = await ctx.db.select().from(aiCalls).where(eq(aiCalls.lookItemId, id));
    expect(calls.map((c) => c.status)).toEqual(['invalid']);
    expect(await statusOf(id)).toBe('pending');
  });

  it('pauses a check until tomorrow (UTC) once the daily cap is reached', async () => {
    await ctx.db.insert(aiCalls).values({
      purpose: 'spot_garments',
      model: 'gemini-3.1-flash-lite',
      promptVersion: 'spot-v1',
      status: 'ok',
      costMicros: 5_000_000,
      durationMs: 1,
    });
    const before = gemini.calls.length;
    const { id } = await setup(alike(0.7), unitVector(0));
    await expect
      .poll(
        async () =>
          (await boss.findJobs(QUEUES.linkCheck, { key: id }))
            .find((j) => j.state === 'created')
            ?.startAfter.getTime(),
        { timeout: 15_000 },
      )
      .toBe(nextUtcDay().getTime());
    expect(gemini.calls.length).toBe(before);
    expect(logged).toContainEqual(
      expect.objectContaining({
        msg: 'daily AI spend cap reached: link checks paused until 00:00 UTC',
      }),
    );
  });

  it('sweeps pending items every hour', async () => {
    const schedules = await boss.getSchedules();
    expect(schedules.find((s) => s.name === QUEUES.linkCheckSweep)?.cron).toBe('23 * * * *');
  });
});
