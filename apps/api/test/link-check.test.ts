import {
  aiCalls,
  and,
  eq,
  garments,
  linkChecks,
  lookItems,
  lookMedia,
  media,
  moderationQueue,
  offers,
  products,
  settings,
  sql,
} from '@outfitly/db';
import { FINGERPRINT_DIMENSIONS } from '@outfitly/shared';
import sharp from 'sharp';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { GeminiClient } from '../src/ai/gemini.ts';
import { SpendCapReachedError } from '../src/ai/photos.ts';
import {
  addLookItem,
  checkLookItem,
  chooseGarment,
  CompareAnswerError,
  compareWithAi,
  decideByScore,
  LINK_CHECK_QUEUES,
  type LinkCheckDeps,
  type NewLookItem,
  queueChecksForPhoto,
  queueChecksForProduct,
  RecheckNowError,
  recheckLookItems,
  removeLookItems,
  sweepPendingChecks,
  THRESHOLDS_SETTING,
} from '../src/links/check.ts';
import { parseCompareAnswer } from '../src/links/compare.ts';
import { forgetCachedSettings } from '../src/settings.ts';
import { fakeFetch, fakeGemini, geminiResponse, json, unitVector } from './ai-fakes.ts';
import { createAuthor, createLook } from './feed-fixtures.ts';
import { createTestContext, type TestContext } from './helpers.ts';

const MODEL = 'Marqo/marqo-fashionSigLIP@c56244c';
let ctx: TestContext;
let authorId: string;
let photo: Buffer;

beforeAll(async () => {
  ctx = await createTestContext();
  authorId = await createAuthor(ctx.db, 'linkchecker');
  // A real picture: the AI step cuts the garment out of it.
  photo = await sharp({
    create: { width: 300, height: 400, channels: 3, background: '#b08f6a' },
  })
    .webp()
    .toBuffer();
});

afterAll(async () => {
  await ctx.close();
});

beforeEach(async () => {
  await ctx.db.delete(aiCalls);
  ctx.queued.length = 0;
  await setThresholds({ verifyAt: 0.85, rejectBelow: 0.55 });
});

async function setThresholds(value: { verifyAt: number; rejectBelow: number }) {
  await ctx.db.update(settings).set({ value }).where(eq(settings.key, THRESHOLDS_SETTING));
  forgetCachedSettings();
}

/** A fingerprint whose cosine similarity to `axis(0)` is `similarity`. */
function alike(similarity: number): number[] {
  const v = new Array<number>(FINGERPRINT_DIMENSIONS).fill(0);
  v[0] = similarity;
  v[1] = Math.sqrt(1 - similarity * similarity);
  return v;
}
const PRODUCT_FINGERPRINT = alike(1);

function deps(overrides: Partial<LinkCheckDeps> = {}): LinkCheckDeps {
  return {
    db: ctx.db,
    storage: ctx.storage,
    gemini: null,
    dailyCapMicros: 5_000_000,
    ...overrides,
  };
}

interface Setup {
  lookId: string;
  mediaId: string;
  productId: string;
  offerId: string;
  garmentIds: string[];
}

/** A ready photo with our 1080 copy stored; read by the AI or not. */
async function readyPhoto(spotted: boolean): Promise<string> {
  const id = crypto.randomUUID();
  await ctx.db.insert(media).values({
    id,
    ownerProfileId: authorId,
    status: 'ready',
    originalKey: `originals/${id}`,
    key1080: `m/${id}/1080.webp`,
    key600: `m/${id}/600.webp`,
    key300: `m/${id}/300.webp`,
    width: 300,
    height: 400,
    thumbhash: 'k0oGLQaSVsN0BVhn2oq2Z5SQUQcZ',
    dominantColor: '#a08870',
    spotStatus: spotted ? 'done' : null,
  });
  await ctx.storage.putPublic(`m/${id}/1080.webp`, photo, 'image/webp');
  return id;
}

async function addGarment(
  mediaId: string,
  embedding: number[] | null,
  options: { top?: number; category?: 'coat' | 'sneakers' | 'bag' } = {},
): Promise<string> {
  const top = options.top ?? 0.1;
  const [row] = await ctx.db
    .insert(garments)
    .values({
      mediaId,
      category: options.category ?? 'coat',
      boxLeft: 0.1,
      boxTop: top,
      boxRight: 0.9,
      boxBottom: top + 0.2,
      embedding,
      embeddingModel: embedding === null ? null : MODEL,
    })
    .returning({ id: garments.id });
  return row?.id ?? '';
}

/** A product with a copied, fingerprinted photo (or in another state). */
async function addProduct(
  options: {
    embedding?: number[];
    photo?: 'ready' | 'missing' | 'failed' | 'none' | 'unfingerprinted';
    category?: 'coat' | 'sneakers' | 'bag' | null;
    model?: string;
  } = {},
): Promise<string> {
  const state = options.photo ?? 'ready';
  let photoId: string | null = null;
  if (state !== 'none' && state !== 'missing') {
    const id = crypto.randomUUID();
    const ready = state !== 'failed';
    await ctx.db.insert(media).values({
      id,
      ownerProfileId: null,
      sourceUrl: `https://shop.test/p/${id}.jpg`,
      status: ready ? 'ready' : 'failed',
      originalKey: `originals/${id}`,
      key1080: ready ? `m/${id}/1080.webp` : null,
      key600: ready ? `m/${id}/600.webp` : null,
      key300: ready ? `m/${id}/300.webp` : null,
      width: ready ? 800 : null,
      height: ready ? 1000 : null,
      thumbhash: ready ? 'k0oGLQaSVsN0BVhn2oq2Z5SQUQcZ' : null,
      dominantColor: ready ? '#a08870' : null,
    });
    if (ready) await ctx.storage.putPublic(`m/${id}/1080.webp`, photo, 'image/webp');
    photoId = id;
  }
  const fingerprinted = state === 'ready';
  const [product] = await ctx.db
    .insert(products)
    .values({
      name: 'Wool coat',
      category: options.category ?? null,
      imageUrl: state === 'none' ? null : 'https://shop.test/p/coat.jpg',
      imageMediaId: photoId,
      embedding: fingerprinted ? (options.embedding ?? PRODUCT_FINGERPRINT) : null,
      embeddingModel: fingerprinted ? (options.model ?? MODEL) : null,
    })
    .returning({ id: products.id });
  return product?.id ?? '';
}

/**
 * A published look whose photo was read, with garments at the given
 * similarities to a product that has a copied, fingerprinted photo; the
 * product is sold through one offer, read just now.
 */
async function setup(
  options: {
    similarities?: (number | null)[];
    categories?: ('coat' | 'sneakers' | 'bag')[];
    stock?: 'in_stock' | 'out_of_stock' | 'unknown';
    productPhoto?: 'ready' | 'missing' | 'failed' | 'none' | 'unfingerprinted';
    productCategory?: 'coat' | 'sneakers' | 'bag' | null;
    spotted?: boolean;
    productModel?: string;
  } = {},
): Promise<Setup> {
  const similarities = options.similarities ?? [0.9];
  const lookId = await createLook(ctx.db, { authorId });
  const [link] = await ctx.db
    .select({ mediaId: lookMedia.mediaId })
    .from(lookMedia)
    .where(eq(lookMedia.lookId, lookId));
  const mediaId = link?.mediaId ?? '';
  await ctx.storage.putPublic(`m/${mediaId}/1080.webp`, photo, 'image/webp');
  if (options.spotted !== false) {
    await ctx.db.update(media).set({ spotStatus: 'done' }).where(eq(media.id, mediaId));
  }
  const garmentIds: string[] = [];
  for (const [i, similarity] of similarities.entries()) {
    garmentIds.push(
      await addGarment(mediaId, similarity === null ? null : alike(similarity), {
        top: 0.1 + i * 0.2,
        category: options.categories?.[i] ?? 'coat',
      }),
    );
  }
  const productId = await addProduct({
    photo: options.productPhoto,
    category: options.productCategory,
    model: options.productModel,
  });
  const [offer] = await ctx.db
    .insert(offers)
    .values({
      productId,
      url: `https://shop.test/p/${crypto.randomUUID()}?aff=me`,
      pageUrl: 'https://shop.test/p/coat',
      priceMinor: 129_900,
      currency: 'SEK',
      stock: options.stock ?? 'in_stock',
      lastCheckedAt: new Date(),
    })
    .returning({ id: offers.id });
  return { lookId, mediaId, productId, offerId: offer?.id ?? '', garmentIds };
}

async function itemFor(s: Setup, extra: Partial<NewLookItem> = {}) {
  const { id } = await addLookItem(ctx.db, ctx.queue, {
    lookId: s.lookId,
    offerId: s.offerId,
    ...extra,
  });
  return id;
}

async function item(id: string) {
  const [row] = await ctx.db.select().from(lookItems).where(eq(lookItems.id, id));
  return row;
}

async function checksOf(id: string) {
  return ctx.db
    .select()
    .from(linkChecks)
    .where(eq(linkChecks.lookItemId, id))
    .orderBy(linkChecks.createdAt);
}

async function reviewsOf(id: string) {
  return ctx.db.select().from(moderationQueue).where(eq(moderationQueue.lookItemId, id));
}

const SAME = { same: 'yes', reason: 'Same buttons, collar and colour.' };

describe('the automatic link check (Step 3.5)', () => {
  it('queues a check when an item is added, and leaves a live item as it is', async () => {
    const s = await setup();
    const id = await itemFor(s);
    expect(ctx.queued).toEqual([{ name: LINK_CHECK_QUEUES.linkCheck, data: { lookItemId: id } }]);
    await checkLookItem(deps(), id);
    ctx.queued.length = 0;
    const again = await addLookItem(ctx.db, ctx.queue, { lookId: s.lookId, offerId: s.offerId });
    expect(again).toEqual({ id, queued: false });
    expect((await item(id))?.status).toBe('verified');
    expect(ctx.queued).toEqual([]);
  });

  it('verifies a close match without the AI, and saves the check with its thresholds', async () => {
    const s = await setup({ similarities: [0.91] });
    const id = await itemFor(s);
    const result = await checkLookItem(deps(), id);
    expect(result).toMatchObject({ outcome: 'verified', reason: null });
    const row = await item(id);
    expect(row).toMatchObject({
      status: 'verified',
      // The check's match, never written as the poster's own pick.
      garmentId: null,
      matchedGarmentId: s.garmentIds[0],
      pendingSince: null,
    });
    expect(row?.matchScore).toBeCloseTo(0.91, 2);
    expect(row?.checkedAt).not.toBeNull();
    const [check] = await checksOf(id);
    expect(check).toMatchObject({ outcome: 'verified', aiAnswer: null, reason: null });
    expect(check?.similarity).toBeCloseTo(0.91, 2);
    expect(check?.details).toMatchObject({
      offerId: s.offerId,
      productId: s.productId,
      garmentId: s.garmentIds[0],
      garmentChoice: 'nearest',
      thresholds: { verifyAt: 0.85, rejectBelow: 0.55 },
      fingerprintModel: MODEL,
    });
  });

  it('rejects a clear mismatch without the AI', async () => {
    const s = await setup({ similarities: [0.3] });
    const id = await itemFor(s);
    expect(await checkLookItem(deps(), id)).toMatchObject({
      outcome: 'rejected',
      reason: 'not_similar',
    });
    expect((await item(id))?.status).toBe('rejected');
  });

  it('decides exactly at the thresholds: verifyAt verifies, rejectBelow asks the AI', () => {
    const t = { verifyAt: 0.85, rejectBelow: 0.6 };
    expect(decideByScore(0.85, t)).toBe('verified');
    expect(decideByScore(0.8499, t)).toBe('ask');
    expect(decideByScore(0.6, t)).toBe('ask');
    expect(decideByScore(0.5999, t)).toBe('rejected');
  });

  it('rejects a sold-out item before anything else', async () => {
    const s = await setup({ stock: 'out_of_stock', similarities: [0.99] });
    const id = await itemFor(s);
    expect(await checkLookItem(deps(), id)).toMatchObject({
      outcome: 'rejected',
      reason: 'sold_out',
    });
    const [check] = await checksOf(id);
    expect(check?.similarity).toBeNull();
  });

  it('rejects an item whose offer was removed', async () => {
    const s = await setup();
    const id = await itemFor(s);
    await ctx.db.update(offers).set({ deletedAt: new Date() }).where(eq(offers.id, s.offerId));
    expect(await checkLookItem(deps(), id)).toMatchObject({
      outcome: 'rejected',
      reason: 'link_removed',
    });
  });

  it('reads the thresholds from settings, not code', async () => {
    const s = await setup({ similarities: [0.7] });
    const id = await itemFor(s);
    await setThresholds({ verifyAt: 0.65, rejectBelow: 0.4 });
    expect(await checkLookItem(deps(), id)).toMatchObject({ outcome: 'verified' });
    const [check] = await checksOf(id);
    expect(check?.details).toMatchObject({ thresholds: { verifyAt: 0.65, rejectBelow: 0.4 } });
  });

  it('refuses wrong thresholds in settings', async () => {
    const s = await setup({ similarities: [0.7] });
    const id = await itemFor(s);
    for (const wrong of [
      { verifyAt: 0.4, rejectBelow: 0.3 },
      { verifyAt: 0.7, rejectBelow: 0.7 },
      { verifyAt: 0, rejectBelow: 0 },
    ]) {
      await setThresholds(wrong);
      await expect(checkLookItem(deps(), id)).rejects.toThrow(/link_check_thresholds/);
    }
    expect((await item(id))?.status).toBe('pending');
  });

  it('fills in a product’s category only from a clear fingerprint match', async () => {
    const s = await setup({ similarities: [0.95], categories: ['bag'] });
    await checkLookItem(deps(), await itemFor(s));
    const category = async (id: string) =>
      (await ctx.db.select({ c: products.category }).from(products).where(eq(products.id, id)))[0]
        ?.c;
    expect(await category(s.productId)).toBe('bag');
    // Verified by the AI's yes: not sure enough to name the product's category.
    const t = await setup({ similarities: [0.7], categories: ['bag'] });
    const gemini = fakeGemini(() => geminiResponse(SAME));
    await checkLookItem(deps({ gemini: gemini.client }), await itemFor(t));
    expect(await category(t.productId)).toBeNull();
  });

  describe('in the middle, the AI decides', () => {
    it('yes → verified, and the call is logged with its cost and look item', async () => {
      const s = await setup({ similarities: [0.7] });
      const id = await itemFor(s);
      const gemini = fakeGemini(() => geminiResponse(SAME));
      const result = await checkLookItem(deps({ gemini: gemini.client }), id);
      expect(result).toMatchObject({ outcome: 'verified', reason: null });

      // Two photos, each labelled: the cut-out garment and the product photo.
      const body = gemini.calls[0]?.body as {
        contents: { parts: ({ text?: string } & { inlineData?: { data: string } })[] }[];
      };
      const parts = body.contents[0]?.parts ?? [];
      expect(parts.map((p) => p.text ?? 'photo')).toEqual([
        'Photo A (the piece in the outfit):',
        'photo',
        'Photo B (the shop product):',
        'photo',
        expect.stringContaining('Is the piece in photo A the same product'),
      ]);
      const crop = await sharp(Buffer.from(parts[1]?.inlineData?.data ?? '', 'base64')).metadata();
      expect(crop.format).toBe('webp');
      // The garment's box (0.1–0.9 wide, 0.1–0.3 tall) with a little room, never the whole photo.
      expect(crop.width).toBeLessThan(300);
      expect(crop.height).toBeLessThan(140);

      const [call] = await ctx.db.select().from(aiCalls);
      expect(call).toMatchObject({
        purpose: 'link_check',
        promptVersion: 'link-check-v1',
        status: 'ok',
        mediaId: s.mediaId,
        lookId: s.lookId,
        lookItemId: id,
      });
      expect(call?.costMicros).toBeGreaterThan(0);
      const [check] = await checksOf(id);
      expect(check).toMatchObject({ outcome: 'verified', aiAnswer: 'yes' });
      expect(check?.details).toMatchObject({
        aiCallId: call?.id,
        aiReason: 'Same buttons, collar and colour.',
        promptVersion: 'link-check-v1',
      });
    });

    it('asks with its own settings: little thinking, the model’s image detail, a small answer', async () => {
      const s = await setup({ similarities: [0.7] });
      const id = await itemFor(s);
      // A client set up for spotting with lots of thinking and high detail.
      const fake = fakeFetch(() => geminiResponse(SAME));
      const client = new GeminiClient({
        apiKey: 'k',
        model: 'gemini-3.1-flash-lite',
        thinkingLevel: 'HIGH',
        mediaResolution: 'HIGH',
        fetch: fake.fetch,
      });
      await checkLookItem(deps({ gemini: client }), id);
      const config = (fake.calls[0]?.body as { generationConfig: Record<string, unknown> })
        .generationConfig;
      expect(config.thinkingConfig).toEqual({ thinkingLevel: 'MINIMAL' });
      expect(config).not.toHaveProperty('mediaResolution');
      expect(config.maxOutputTokens).toBe(512);
    });

    it('no → rejected', async () => {
      const s = await setup({ similarities: [0.7] });
      const id = await itemFor(s);
      const gemini = fakeGemini(() => geminiResponse({ same: 'no', reason: 'Other collar.' }));
      expect(await checkLookItem(deps({ gemini: gemini.client }), id)).toMatchObject({
        outcome: 'rejected',
        reason: 'ai_different',
      });
    });

    it('unsure → review, with one open item in the review queue', async () => {
      const s = await setup({ similarities: [0.7] });
      const id = await itemFor(s);
      const gemini = fakeGemini(() => geminiResponse({ same: 'unsure', reason: 'Too dark.' }));
      expect(await checkLookItem(deps({ gemini: gemini.client }), id)).toMatchObject({
        outcome: 'review',
        reason: 'ai_unsure',
      });
      expect((await item(id))?.status).toBe('review');
      const queued = await reviewsOf(id);
      expect(queued).toHaveLength(1);
      expect(queued[0]).toMatchObject({ kind: 'link_check', status: 'open', mediaId: null });
      // An item waiting for a person isn't checked again (and the AI isn't paid again).
      expect(await checkLookItem(deps({ gemini: gemini.client }), id)).toEqual({
        outcome: 'skipped',
        reason: 'not pending',
      });
      expect(gemini.calls).toHaveLength(1);
    });

    it('a refusal counts as unsure', async () => {
      const s = await setup({ similarities: [0.7] });
      const id = await itemFor(s);
      const gemini = fakeGemini(() =>
        json({
          promptFeedback: { blockReason: 'SAFETY' },
          usageMetadata: { promptTokenCount: 900 },
        }),
      );
      expect(await checkLookItem(deps({ gemini: gemini.client }), id)).toMatchObject({
        outcome: 'review',
        reason: 'ai_unsure',
      });
      const [check] = await checksOf(id);
      expect(check?.aiAnswer).toBeNull();
      expect(check?.details).toMatchObject({ aiRefusal: 'SAFETY' });
      const [call] = await ctx.db.select().from(aiCalls);
      expect(call?.status).toBe('blocked');
    });

    it('without a Gemini key it stays pending: never decided without the AI', async () => {
      const s = await setup({ similarities: [0.7] });
      const id = await itemFor(s);
      expect(await checkLookItem(deps({ gemini: null }), id)).toEqual({
        outcome: 'waiting',
        reason: 'no Gemini key',
      });
      expect((await item(id))?.status).toBe('pending');
      expect(await checksOf(id)).toEqual([]);
    });

    it('stops at the daily spend cap without calling', async () => {
      const s = await setup({ similarities: [0.7] });
      const id = await itemFor(s);
      await ctx.db.insert(aiCalls).values({
        purpose: 'spot_garments',
        model: 'gemini-3.1-flash-lite',
        promptVersion: 'spot-v1',
        status: 'ok',
        costMicros: 5_000_000,
        durationMs: 1,
      });
      const gemini = fakeGemini(() => geminiResponse(SAME));
      await expect(checkLookItem(deps({ gemini: gemini.client }), id)).rejects.toBeInstanceOf(
        SpendCapReachedError,
      );
      expect(gemini.calls).toHaveLength(0);
      expect((await item(id))?.status).toBe('pending');
    });

    it('a paid answer we can’t use is tried once more later; the second sends it to a person', async () => {
      const s = await setup({ similarities: [0.7] });
      const id = await itemFor(s);
      const gemini = fakeGemini(() => geminiResponse({ maybe: true }));
      await expect(checkLookItem(deps({ gemini: gemini.client }), id)).rejects.toBeInstanceOf(
        CompareAnswerError,
      );
      expect((await item(id))?.status).toBe('pending');
      expect(await checkLookItem(deps({ gemini: gemini.client }), id)).toMatchObject({
        outcome: 'review',
        reason: 'ai_unsure',
      });
      const [check] = await checksOf(id);
      expect(check?.details).toMatchObject({ aiFailures: 2 });
      const calls = await ctx.db.select().from(aiCalls);
      expect(calls.map((c) => [c.status, c.lookItemId])).toEqual([
        ['invalid', id],
        ['invalid', id],
      ]);
      // Never a third paid try.
      expect(gemini.calls).toHaveLength(2);
    });

    it('a timed-out call (maybe billed) counts as a paid failure', async () => {
      const s = await setup({ similarities: [0.7] });
      const id = await itemFor(s);
      const slow = fakeGemini(() =>
        Promise.reject(new DOMException('The operation timed out.', 'TimeoutError')),
      );
      await expect(checkLookItem(deps({ gemini: slow.client }), id)).rejects.toBeInstanceOf(
        CompareAnswerError,
      );
      const [call] = await ctx.db.select().from(aiCalls);
      expect(call?.costMicros).toBeGreaterThan(0);
    });

    it('Gemini down is retried for free; a refused request (bad key) waits', async () => {
      const s = await setup({ similarities: [0.7] });
      const id = await itemFor(s);
      const down = fakeGemini(() => json({ error: 'busy' }, 503));
      await expect(checkLookItem(deps({ gemini: down.client }), id)).rejects.toMatchObject({
        retryable: true,
      });
      const badKey = fakeGemini(() => json({ error: 'bad key' }, 400));
      expect(await checkLookItem(deps({ gemini: badKey.client }), id)).toEqual({
        outcome: 'waiting',
        reason: 'AI failed',
      });
      expect((await item(id))?.status).toBe('pending');
      const calls = await ctx.db.select().from(aiCalls);
      expect(calls.map((c) => [c.status, c.costMicros])).toEqual([
        ['failed', 0],
        ['failed', 0],
      ]);
    });

    it('a look photo that is gone goes to a person', async () => {
      const s = await setup({ similarities: [0.7] });
      const gemini = fakeGemini(() => geminiResponse(SAME));
      await ctx.db.update(media).set({ deletedAt: new Date() }).where(eq(media.id, s.mediaId));
      const asked = await compareWithAi(deps({ gemini: gemini.client }), {
        lookId: s.lookId,
        lookItemId: null,
        productPhotoKey: 'm/none/1080.webp',
        garment: {
          id: s.garmentIds[0] ?? '',
          mediaId: s.mediaId,
          category: 'coat',
          box: { left: 0.1, top: 0.1, right: 0.9, bottom: 0.3 },
          embeddingModel: MODEL,
          hasFingerprint: true,
          similarity: 0.7,
          taken: false,
        },
      });
      expect(asked).toEqual({ failed: 'the look photo is gone' });
      expect(gemini.calls).toHaveLength(0);
    });
  });

  describe('waiting for missing parts', () => {
    it('waits for the look photo to be read, then sends a piece-less look to review', async () => {
      const s = await setup({ similarities: [], spotted: false });
      const id = await itemFor(s);
      expect(await checkLookItem(deps(), id)).toEqual({
        outcome: 'waiting',
        reason: 'photo not read',
      });
      await ctx.db.update(media).set({ spotStatus: 'done' }).where(eq(media.id, s.mediaId));
      expect(await checkLookItem(deps(), id)).toMatchObject({
        outcome: 'review',
        reason: 'no_garment',
      });
    });

    it('waits until every photo of the look is read (its piece may be on the last one)', async () => {
      // Photo 1 is read: a coat unlike the product (a bag). Photo 2, with the bag, isn't yet.
      const s = await setup({ similarities: [0.1] });
      const second = await readyPhoto(false);
      await ctx.db.insert(lookMedia).values({ lookId: s.lookId, mediaId: second, position: 1 });
      const id = await itemFor(s);
      expect(await checkLookItem(deps(), id)).toEqual({
        outcome: 'waiting',
        reason: 'photo not read',
      });
      await ctx.db.update(media).set({ spotStatus: 'done' }).where(eq(media.id, second));
      const bag = await addGarment(second, alike(0.97), { category: 'bag' });
      expect(await checkLookItem(deps(), id)).toMatchObject({ outcome: 'verified' });
      expect((await item(id))?.matchedGarmentId).toBe(bag);
    });

    it('waits for garment and product fingerprints, but not forever', async () => {
      const s = await setup({ similarities: [null] });
      const id = await itemFor(s);
      expect(await checkLookItem(deps(), id)).toEqual({
        outcome: 'waiting',
        reason: 'garment fingerprint',
      });
      const t = await setup({ productPhoto: 'unfingerprinted' });
      const other = await itemFor(t);
      expect(await checkLookItem(deps(), other)).toEqual({
        outcome: 'waiting',
        reason: 'product fingerprint',
      });
      // Three days later the fingerprint still hasn't come: a person checks.
      await ctx.db
        .update(lookItems)
        .set({ pendingSince: sql`now() - interval '4 days'` })
        .where(eq(lookItems.id, id));
      expect(await checkLookItem(deps(), id)).toMatchObject({
        outcome: 'review',
        reason: 'check_failed',
      });
      const [check] = await checksOf(id);
      expect(check?.details).toMatchObject({ waitedFor: 'garment fingerprint' });
    });

    it('never compares fingerprints from different models', async () => {
      const s = await setup({ productModel: 'some-other-model' });
      const id = await itemFor(s);
      expect(await checkLookItem(deps(), id)).toEqual({
        outcome: 'waiting',
        reason: 'models differ',
      });
    });

    it('waits for a shop photo on its way; one that was refused, failed or never came goes to review', async () => {
      const s = await setup({ productPhoto: 'missing' });
      const id = await itemFor(s);
      expect(await checkLookItem(deps(), id)).toEqual({
        outcome: 'waiting',
        reason: 'product photo',
      });
      // An hour after the link was read it isn't coming.
      await ctx.db
        .update(offers)
        .set({ lastCheckedAt: sql`now() - interval '2 hours'` })
        .where(eq(offers.id, s.offerId));
      expect(await checkLookItem(deps(), id)).toMatchObject({
        outcome: 'review',
        reason: 'no_product_photo',
      });
      // Refused when copying: no need to wait the hour.
      const refused = await setup({ productPhoto: 'missing' });
      await ctx.db
        .update(products)
        .set({ imageFailedAt: new Date() })
        .where(eq(products.id, refused.productId));
      expect(await checkLookItem(deps(), await itemFor(refused))).toMatchObject({
        reason: 'no_product_photo',
      });
      const failed = await setup({ productPhoto: 'failed' });
      expect(await checkLookItem(deps(), await itemFor(failed))).toMatchObject({
        reason: 'no_product_photo',
      });
      const none = await setup({ productPhoto: 'none' });
      expect(await checkLookItem(deps(), await itemFor(none))).toMatchObject({
        reason: 'no_product_photo',
      });
    });
  });

  describe('which garment', () => {
    it('takes the poster’s pick and keeps it theirs', async () => {
      const s = await setup({ similarities: [0.95, 0.3] });
      const id = await itemFor(s, { garmentId: s.garmentIds[1] ?? null });
      expect(await checkLookItem(deps(), id)).toMatchObject({
        outcome: 'rejected',
        reason: 'not_similar',
      });
      expect(await item(id)).toMatchObject({
        garmentId: s.garmentIds[1],
        matchedGarmentId: s.garmentIds[1],
      });
      const [check] = await checksOf(id);
      expect(check?.details).toMatchObject({ garmentChoice: 'given' });
    });

    it('takes the piece under the poster’s dot', async () => {
      const s = await setup({ similarities: [0.95, 0.3] });
      // Garment 1's box is 0.3–0.5 tall.
      const id = await itemFor(s, { dot: { mediaId: s.mediaId, x: 0.5, y: 0.4 } });
      await checkLookItem(deps(), id);
      expect(await item(id)).toMatchObject({ garmentId: null, matchedGarmentId: s.garmentIds[1] });
      const [check] = await checksOf(id);
      expect(check?.details).toMatchObject({ garmentChoice: 'dot' });
    });

    it('a dot on no piece goes to a person instead of guessing', async () => {
      const s = await setup({ similarities: [0.95] });
      // The only piece is 0.1–0.3 tall; the dot is near the bottom.
      const id = await itemFor(s, { dot: { mediaId: s.mediaId, x: 0.5, y: 0.9 } });
      expect(await checkLookItem(deps(), id)).toMatchObject({
        outcome: 'review',
        reason: 'dot_not_on_piece',
      });
    });

    it('else the piece most like the product, preferring its category and free pieces', () => {
      const piece = (id: string, similarity: number, category: 'coat' | 'bag', taken = false) => ({
        id,
        mediaId: 'm',
        category,
        box: { left: 0, top: 0, right: 1, bottom: 1 },
        embeddingModel: MODEL,
        hasFingerprint: true,
        similarity,
        taken,
      });
      const noDot = { garmentId: null, mediaId: null, dotX: null, dotY: null };
      const pieces = [
        piece('a', 0.9, 'bag'),
        piece('b', 0.7, 'coat'),
        piece('c', 0.8, 'coat', true),
      ];
      expect(chooseGarment(pieces, noDot, null)).toMatchObject({
        garment: { id: 'a' },
        choice: 'nearest',
      });
      expect(chooseGarment(pieces, noDot, 'coat')).toMatchObject({
        garment: { id: 'b' },
        choice: 'nearest in category',
      });
      // When every piece is taken, the nearest still wins.
      expect(chooseGarment([piece('c', 0.8, 'coat', true)], noDot, null)?.garment.id).toBe('c');
    });

    it('a piece the check chose is not the poster’s pick when the link is checked again', async () => {
      const s = await setup({ similarities: [0.9, 0] });
      const [a, b] = s.garmentIds;
      const id = await itemFor(s);
      expect(await checkLookItem(deps(), id)).toMatchObject({ outcome: 'verified' });
      expect((await item(id))?.matchedGarmentId).toBe(a);
      // The link now shows another item, exactly like piece b.
      await ctx.db
        .update(products)
        .set({ embedding: alike(0) })
        .where(eq(products.id, s.productId));
      await recheckLookItems(ctx.db, [s.offerId]);
      expect(await checkLookItem(deps(), id)).toMatchObject({ outcome: 'verified' });
      expect(await item(id)).toMatchObject({ garmentId: null, matchedGarmentId: b });
      const checks = await checksOf(id);
      // The first match named the product a coat, so the second looks among coats first.
      expect(checks.map((c) => (c.details as { garmentChoice: string }).garmentChoice)).toEqual([
        'nearest',
        'nearest in category',
      ]);
    });
  });

  describe('once per check', () => {
    it('a retry after the decision changes nothing', async () => {
      const s = await setup({ similarities: [0.9] });
      const id = await itemFor(s);
      await checkLookItem(deps(), id);
      expect(await checkLookItem(deps(), id)).toEqual({
        outcome: 'skipped',
        reason: 'not pending',
      });
      expect(await checksOf(id)).toHaveLength(1);
    });

    it('two checks at once decide once', async () => {
      const s = await setup({ similarities: [0.9] });
      const id = await itemFor(s);
      const results = await Promise.all([1, 2, 3].map(() => checkLookItem(deps(), id)));
      expect(results.filter((r) => r.outcome === 'verified')).toHaveLength(1);
      expect(await checksOf(id)).toHaveLength(1);
    });

    it('a link that moves to another product while the AI is asked is checked against the new one', async () => {
      const s = await setup({ similarities: [0.7] });
      const other = await addProduct({ embedding: unitVector(5) });
      const id = await itemFor(s);
      const gemini = fakeGemini(async () => {
        // A re-read of the link meanwhile: the offer now shows the other product.
        await ctx.db.update(offers).set({ productId: other }).where(eq(offers.id, s.offerId));
        await recheckLookItems(ctx.db, [s.offerId]);
        return geminiResponse(SAME);
      });
      expect(await checkLookItem(deps({ gemini: gemini.client }), id)).toEqual({
        outcome: 'skipped',
        reason: 'changed meanwhile',
      });
      expect(await checksOf(id)).toHaveLength(0);
      // The recheck job: the new product is nothing like the coat.
      expect(await checkLookItem(deps(), id)).toMatchObject({
        outcome: 'rejected',
        reason: 'not_similar',
      });
    });

    it('a piece replaced while the AI is asked (a re-read) means checking again', async () => {
      const s = await setup({ similarities: [0.7] });
      const id = await itemFor(s);
      const gemini = fakeGemini(async () => {
        await ctx.db
          .update(garments)
          .set({ deletedAt: new Date() })
          .where(eq(garments.mediaId, s.mediaId));
        return geminiResponse(SAME);
      });
      await expect(checkLookItem(deps({ gemini: gemini.client }), id)).rejects.toBeInstanceOf(
        RecheckNowError,
      );
      expect((await item(id))?.status).toBe('pending');
    });

    it('two items don’t claim the same free piece at once', async () => {
      const s = await setup({ similarities: [0.7] });
      const first = await itemFor(s);
      const otherOffer = await ctx.db
        .insert(offers)
        .values({
          productId: s.productId,
          url: `https://shop.test/p/${crypto.randomUUID()}`,
          pageUrl: 'https://shop.test/p/coat-2',
          stock: 'in_stock',
          lastCheckedAt: new Date(),
        })
        .returning({ id: offers.id });
      const second = await addLookItem(ctx.db, ctx.queue, {
        lookId: s.lookId,
        offerId: otherOffer[0]?.id ?? '',
      });
      const gemini = fakeGemini(async () => {
        // Meanwhile the other item is decided with the same (then free) piece.
        await ctx.db
          .update(lookItems)
          .set({ status: 'verified', matchedGarmentId: s.garmentIds[0] })
          .where(eq(lookItems.id, second.id));
        return geminiResponse(SAME);
      });
      await expect(checkLookItem(deps({ gemini: gemini.client }), first)).rejects.toBeInstanceOf(
        RecheckNowError,
      );
      // Checked again, the piece is taken by then and still the only one: it's chosen knowingly.
      const again = fakeGemini(() => geminiResponse(SAME));
      expect(await checkLookItem(deps({ gemini: again.client }), first)).toMatchObject({
        outcome: 'verified',
      });
    });

    it('a review item checked again closes its open review', async () => {
      const s = await setup({ similarities: [0.7] });
      const id = await itemFor(s);
      const unsure = fakeGemini(() => geminiResponse({ same: 'unsure', reason: 'Dark.' }));
      await checkLookItem(deps({ gemini: unsure.client }), id);
      expect((await reviewsOf(id))[0]?.status).toBe('open');
      expect(await recheckLookItems(ctx.db, [s.offerId])).toEqual([id]);
      expect(await item(id)).toMatchObject({
        status: 'pending',
        matchScore: null,
        matchedGarmentId: null,
      });
      expect((await item(id))?.pendingSince).not.toBeNull();
      const [closed] = await reviewsOf(id);
      expect(closed).toMatchObject({ status: 'removed', note: 'the link now shows another item' });
      const yes = fakeGemini(() => geminiResponse(SAME));
      expect(await checkLookItem(deps({ gemini: yes.client }), id)).toMatchObject({
        outcome: 'verified',
      });
      expect(await checksOf(id)).toHaveLength(2);
    });

    it('a removed item closes its open review; added again it starts over', async () => {
      const s = await setup({ similarities: [0.7] });
      const id = await itemFor(s);
      const unsure = fakeGemini(() => geminiResponse({ same: 'unsure', reason: 'Dark.' }));
      await checkLookItem(deps({ gemini: unsure.client }), id);
      await removeLookItems(ctx.db, [id]);
      expect((await reviewsOf(id))[0]).toMatchObject({
        status: 'removed',
        note: 'item removed from the look',
      });
      ctx.queued.length = 0;
      const again = await addLookItem(ctx.db, ctx.queue, { lookId: s.lookId, offerId: s.offerId });
      expect(again).toEqual({ id, queued: true });
      expect(await item(id)).toMatchObject({
        status: 'pending',
        deletedAt: null,
        matchedGarmentId: null,
      });
    });
  });

  describe('triggers', () => {
    it('queues an item’s check when its photo or its product is ready', async () => {
      const s = await setup({ similarities: [null] });
      const id = await itemFor(s);
      ctx.queued.length = 0;
      expect(await queueChecksForPhoto(ctx.queue, ctx.db, s.mediaId)).toBe(1);
      expect(await queueChecksForProduct(ctx.queue, ctx.db, s.productId)).toBe(1);
      expect(ctx.queued.map((j) => (j.data as { lookItemId: string }).lookItemId)).toEqual([
        id,
        id,
      ]);
      // Decided items are left alone.
      await ctx.db.update(lookItems).set({ status: 'verified' }).where(eq(lookItems.id, id));
      expect(await queueChecksForPhoto(ctx.queue, ctx.db, s.mediaId)).toBe(0);
    });

    it('the sweep asks about the least recently tried first, and rests just-tried ones', async () => {
      await ctx.db
        .update(lookItems)
        .set({ status: 'verified' })
        .where(eq(lookItems.status, 'pending'));
      const s = await setup({ similarities: [null] });
      const tried = await itemFor(s);
      await checkLookItem(deps(), tried); // waits for its fingerprint; tried just now
      const t = await setup({ similarities: [null] });
      const older = await itemFor(t);
      const u = await setup({ similarities: [null] });
      const never = await itemFor(u);
      await ctx.db
        .update(lookItems)
        .set({ checkedAt: sql`now() - interval '2 hours'` })
        .where(eq(lookItems.id, older));
      ctx.queued.length = 0;
      expect(await sweepPendingChecks(ctx.queue, ctx.db)).toBe(2);
      expect(ctx.queued.map((j) => (j.data as { lookItemId: string }).lookItemId)).toEqual([
        never,
        older,
      ]);
    });
  });

  it('reads the AI’s answer strictly', () => {
    expect(parseCompareAnswer('{"same":"yes","reason":"  Same   collar. "}')).toEqual({
      same: 'yes',
      reason: 'Same collar.',
    });
    expect(parseCompareAnswer('{"same":"maybe","reason":""}')).toBeNull();
    expect(parseCompareAnswer('not json')).toBeNull();
    expect(parseCompareAnswer('{"same":"no","reason":""}')).toEqual({ same: 'no', reason: null });
  });
});

describe('the review queue and check log for links', () => {
  it('refuses an item without a photo or look item', async () => {
    await expect(ctx.db.insert(moderationQueue).values({ kind: 'link_check' })).rejects.toThrow();
  });

  it('keeps one open item per look item', async () => {
    const s = await setup();
    const id = await itemFor(s);
    await ctx.db.insert(moderationQueue).values({ kind: 'link_check', lookItemId: id });
    await expect(
      ctx.db.insert(moderationQueue).values({ kind: 'link_check', lookItemId: id }),
    ).rejects.toThrow();
    const open = await ctx.db
      .select()
      .from(moderationQueue)
      .where(and(eq(moderationQueue.lookItemId, id), eq(moderationQueue.status, 'open')));
    expect(open).toHaveLength(1);
  });

  it('refuses a reason code the app has no message for', async () => {
    const s = await setup();
    const id = await itemFor(s);
    await expect(
      ctx.db.insert(linkChecks).values({ lookItemId: id, outcome: 'rejected', reason: 'whatever' }),
    ).rejects.toThrow();
  });
});
