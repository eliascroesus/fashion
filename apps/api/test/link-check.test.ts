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
import { SpendCapReachedError } from '../src/ai/photos.ts';
import {
  addLookItem,
  checkLookItem,
  chooseGarment,
  CompareAnswerError,
  LINK_CHECK_QUEUES,
  type LinkCheckDeps,
  type NewLookItem,
  queueChecksForPhoto,
  queueChecksForProduct,
  recheckLookItems,
  sweepPendingChecks,
  THRESHOLDS_SETTING,
} from '../src/links/check.ts';
import { parseCompareAnswer } from '../src/links/compare.ts';
import { forgetCachedSettings } from '../src/settings.ts';
import { fakeGemini, geminiResponse, json } from './ai-fakes.ts';
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

/**
 * A published look whose photo was read, with garments at the given
 * similarities to a product that has a copied, fingerprinted photo; the
 * product is sold through one offer.
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
    const [row] = await ctx.db
      .insert(garments)
      .values({
        mediaId,
        category: options.categories?.[i] ?? 'coat',
        boxLeft: 0.1 + i * 0.01,
        boxTop: 0.1 + i * 0.2,
        boxRight: 0.9,
        boxBottom: 0.3 + i * 0.2,
        embedding: similarity === null ? null : alike(similarity),
        embeddingModel: similarity === null ? null : MODEL,
      })
      .returning({ id: garments.id });
    garmentIds.push(row?.id ?? '');
  }

  const productPhoto = options.productPhoto ?? 'ready';
  let photoId: string | null = null;
  if (productPhoto !== 'none' && productPhoto !== 'missing') {
    const id = crypto.randomUUID();
    const ready = productPhoto !== 'failed';
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
  const fingerprinted = productPhoto === 'ready';
  const [product] = await ctx.db
    .insert(products)
    .values({
      name: 'Wool coat',
      category: options.productCategory ?? null,
      imageUrl: productPhoto === 'none' ? null : 'https://shop.test/p/coat.jpg',
      imageMediaId: photoId,
      embedding: fingerprinted ? PRODUCT_FINGERPRINT : null,
      embeddingModel: fingerprinted ? (options.productModel ?? MODEL) : null,
    })
    .returning({ id: products.id });
  const productId = product?.id ?? '';
  const [offer] = await ctx.db
    .insert(offers)
    .values({
      productId,
      url: `https://shop.test/p/${crypto.randomUUID()}?aff=me`,
      pageUrl: 'https://shop.test/p/coat',
      priceMinor: 129_900,
      currency: 'SEK',
      stock: options.stock ?? 'in_stock',
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
  return ctx.db.select().from(linkChecks).where(eq(linkChecks.lookItemId, id));
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
    expect(row?.status).toBe('verified');
    expect(row?.garmentId).toBe(s.garmentIds[0]);
    expect(row?.matchScore).toBeCloseTo(0.91, 2);
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
    await setThresholds({ verifyAt: 0.4, rejectBelow: 0.65 });
    await expect(checkLookItem(deps(), id)).rejects.toThrow(/link_check_thresholds/);
    expect((await item(id))?.status).toBe('pending');
  });

  describe('in the middle, the AI decides', () => {
    it('yes → verified, and the call is logged with its cost', async () => {
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
      const queued = await ctx.db
        .select()
        .from(moderationQueue)
        .where(eq(moderationQueue.lookItemId, id));
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

    it('an unusable answer is logged and retried, not decided', async () => {
      const s = await setup({ similarities: [0.7] });
      const id = await itemFor(s);
      const gemini = fakeGemini(() => geminiResponse({ maybe: true }));
      await expect(checkLookItem(deps({ gemini: gemini.client }), id)).rejects.toBeInstanceOf(
        CompareAnswerError,
      );
      const [call] = await ctx.db.select().from(aiCalls);
      expect(call?.status).toBe('invalid');
      expect((await item(id))?.status).toBe('pending');
    });

    it('Gemini down is retried; a refused request (bad key) waits', async () => {
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
      expect(calls.map((c) => c.status)).toEqual(['failed', 'failed']);
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

    it('waits for garment and product fingerprints', async () => {
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
    });

    it('never compares fingerprints from different models', async () => {
      const s = await setup({ productModel: 'some-other-model' });
      const id = await itemFor(s);
      expect(await checkLookItem(deps(), id)).toEqual({
        outcome: 'waiting',
        reason: 'models differ',
      });
    });

    it('waits for a shop photo on its way; one that failed or never came goes to review', async () => {
      const s = await setup({ productPhoto: 'missing' });
      const id = await itemFor(s);
      expect(await checkLookItem(deps(), id)).toEqual({
        outcome: 'waiting',
        reason: 'product photo',
      });
      // An hour later it isn't coming.
      await ctx.db
        .update(products)
        .set({ updatedAt: sql`now() - interval '2 hours'` })
        .where(eq(products.id, s.productId));
      expect(await checkLookItem(deps(), id)).toMatchObject({
        outcome: 'review',
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
    it('takes the poster’s pick', async () => {
      const s = await setup({ similarities: [0.95, 0.3] });
      const id = await itemFor(s, { garmentId: s.garmentIds[1] ?? null });
      expect(await checkLookItem(deps(), id)).toMatchObject({
        outcome: 'rejected',
        reason: 'not_similar',
      });
      expect((await item(id))?.garmentId).toBe(s.garmentIds[1]);
      const [check] = await checksOf(id);
      expect(check?.details).toMatchObject({ garmentChoice: 'given' });
    });

    it('takes the piece under the poster’s dot', async () => {
      const s = await setup({ similarities: [0.95, 0.3] });
      // Garment 1's box is 0.3–0.5 tall.
      const id = await itemFor(s, { dot: { mediaId: s.mediaId, x: 0.5, y: 0.4 } });
      await checkLookItem(deps(), id);
      expect((await item(id))?.garmentId).toBe(s.garmentIds[1]);
      const [check] = await checksOf(id);
      expect(check?.details).toMatchObject({ garmentChoice: 'dot' });
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
      expect(chooseGarment([piece('c', 0.8, 'coat', true)], noDot, null).garment.id).toBe('c');
    });

    it('a verified item gives a product without a category its garment’s', async () => {
      const s = await setup({ similarities: [0.95], categories: ['bag'] });
      await checkLookItem(deps(), await itemFor(s));
      const [product] = await ctx.db
        .select({ category: products.category })
        .from(products)
        .where(eq(products.id, s.productId));
      expect(product?.category).toBe('bag');
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

    it('a link that now shows another item is checked again', async () => {
      const s = await setup({ similarities: [0.9] });
      const id = await itemFor(s);
      await checkLookItem(deps(), id);
      expect(await recheckLookItems(ctx.db, [s.offerId])).toEqual([id]);
      expect(await item(id)).toMatchObject({ status: 'pending', matchScore: null });
      expect(await checkLookItem(deps(), id)).toMatchObject({ outcome: 'verified' });
      expect(await checksOf(id)).toHaveLength(2);
    });

    it('a removed item added again starts over', async () => {
      const s = await setup({ similarities: [0.3] });
      const id = await itemFor(s);
      await checkLookItem(deps(), id);
      await ctx.db.update(lookItems).set({ deletedAt: new Date() }).where(eq(lookItems.id, id));
      ctx.queued.length = 0;
      const again = await addLookItem(ctx.db, ctx.queue, { lookId: s.lookId, offerId: s.offerId });
      expect(again).toEqual({ id, queued: true });
      expect(await item(id)).toMatchObject({ status: 'pending', deletedAt: null });
    });
  });

  describe('triggers', () => {
    it('queues an item’s check when its photo or its product is ready, and in the sweep', async () => {
      const s = await setup({ similarities: [null] });
      const id = await itemFor(s);
      ctx.queued.length = 0;
      expect(await queueChecksForPhoto(ctx.queue, ctx.db, s.mediaId)).toBe(1);
      expect(await queueChecksForProduct(ctx.queue, ctx.db, s.productId)).toBe(1);
      expect(await sweepPendingChecks(ctx.queue, ctx.db)).toBeGreaterThanOrEqual(1);
      expect(
        ctx.queued.filter((j) => (j.data as { lookItemId: string }).lookItemId === id),
      ).toHaveLength(3);
      // Decided items are left alone.
      await ctx.db.update(lookItems).set({ status: 'verified' }).where(eq(lookItems.id, id));
      ctx.queued.length = 0;
      expect(await queueChecksForPhoto(ctx.queue, ctx.db, s.mediaId)).toBe(0);
      const swept = await sweepPendingChecks(ctx.queue, ctx.db);
      expect(
        ctx.queued.slice(-swept).some((j) => (j.data as { lookItemId: string }).lookItemId === id),
      ).toBe(false);
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

// The review queue keeps one open item per look item.
describe('the review queue for links', () => {
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
});
