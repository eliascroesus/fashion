import {
  aiCalls,
  and,
  asc,
  eq,
  garments,
  isNull,
  lookMedia,
  looks,
  media,
  moderationQueue,
  sql,
} from '@outfitly/db';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import {
  fingerprintPhoto,
  nextUtcDay,
  type PhotoAiDeps,
  readWithOlderInstructions,
  refreshLookAi,
  SpendCapReachedError,
  SpotAnswerError,
  spentTodayMicros,
  spotPhoto,
} from '../src/ai/photos.ts';
import { SPOT_PROMPT_VERSION } from '../src/ai/spot.ts';
import { QUEUES, queuePhotoAi } from '../src/jobs.ts';
import {
  COAT_AND_SNEAKERS,
  fakeEmbedder,
  fakeGemini,
  geminiResponse,
  json,
  unitVector,
} from './ai-fakes.ts';
import { createAuthor, createLook } from './feed-fixtures.ts';
import { createTestContext, type TestContext } from './helpers.ts';

let ctx: TestContext;
let authorId: string;

beforeAll(async () => {
  ctx = await createTestContext();
  authorId = await createAuthor(ctx.db, 'spotter');
});

afterAll(async () => {
  await ctx.close();
});

beforeEach(async () => {
  // Each test starts with nothing spent today.
  await ctx.db.delete(aiCalls);
});

/** A published look whose cover photo is ready and stored; returns both ids. */
async function lookWithPhoto(
  status: 'published' | 'draft' = 'published',
): Promise<{ lookId: string; mediaId: string }> {
  const lookId = await createLook(ctx.db, { authorId, status });
  const [link] = await ctx.db
    .select({ mediaId: lookMedia.mediaId })
    .from(lookMedia)
    .where(eq(lookMedia.lookId, lookId));
  if (!link) throw new Error('look has no photo');
  await ctx.storage.putPublic(`m/${link.mediaId}/1080.webp`, Buffer.from('webp'), 'image/webp');
  return { lookId, mediaId: link.mediaId };
}

function deps(overrides: Partial<PhotoAiDeps> = {}): PhotoAiDeps {
  return {
    db: ctx.db,
    storage: ctx.storage,
    gemini: null,
    embedder: null,
    dailyCapMicros: 5_000_000,
    ...overrides,
  };
}

async function liveGarments(mediaId: string) {
  return ctx.db
    .select()
    .from(garments)
    .where(and(eq(garments.mediaId, mediaId), isNull(garments.deletedAt)))
    .orderBy(asc(garments.createdAt), asc(garments.boxTop));
}

describe('reading a look photo (garment spotting)', () => {
  it('stores the garments, the sentence and search words, and logs the call with its cost', async () => {
    const { lookId, mediaId } = await lookWithPhoto();
    const gemini = fakeGemini(() => geminiResponse(COAT_AND_SNEAKERS));
    const result = await spotPhoto(deps({ gemini: gemini.client }), mediaId);
    // 1,500 input × $0.25 + (300 + 20) output × $1.50 per million tokens.
    expect(result).toEqual({ outcome: 'done', garments: 2, costMicros: 375 + 480 });

    // Our 1080 copy is what Gemini sees.
    const sent = gemini.calls[0]?.body as {
      contents: { parts: { inlineData?: { data: string } }[] }[];
    };
    expect(sent.contents[0]?.parts[0]?.inlineData?.data).toBe(
      Buffer.from('webp').toString('base64'),
    );

    const pieces = await liveGarments(mediaId);
    expect(
      pieces.map((g) => [g.category, g.color, g.boxLeft, g.boxTop, g.boxRight, g.boxBottom]),
    ).toEqual([
      ['coat', 'beige', 0.2, 0.1, 0.8, 0.6],
      ['sneakers', 'white', 0.3, 0.85, 0.7, 0.98],
    ]);
    expect(pieces[1]?.attributes).toEqual({
      pattern: 'solid',
      material: 'leather',
      brandText: 'VEJA',
    });

    const [photo] = await ctx.db.select().from(media).where(eq(media.id, mediaId));
    expect(photo).toMatchObject({
      spotStatus: 'done',
      aiDescription: 'A beige wool coat with white sneakers.',
      aiTags: ['minimal', 'trench coat', 'beige'],
      safetyFlags: [],
    });
    expect(photo?.spottedAt).toBeInstanceOf(Date);

    const [look] = await ctx.db.select().from(looks).where(eq(looks.id, lookId));
    expect(look).toMatchObject({
      status: 'published',
      aiDescription: 'A beige wool coat with white sneakers.',
      aiTags: ['minimal', 'trench coat', 'beige'],
    });
    const { rows } = await ctx.db.execute<{ hit: boolean }>(
      sql`SELECT search_vector @@ to_tsquery('simple', 'trench & coat') AS hit FROM looks WHERE id = ${lookId}`,
    );
    expect(rows[0]?.hit).toBe(true);

    const calls = await ctx.db.select().from(aiCalls).where(eq(aiCalls.mediaId, mediaId));
    expect(calls).toEqual([
      expect.objectContaining({
        purpose: 'spot_garments',
        model: 'gemini-3.1-flash-lite',
        modelVersion: 'gemini-3.1-flash-lite-001',
        promptVersion: 'spot-v3',
        status: 'ok',
        inputTokens: 1500,
        outputTokens: 300,
        thinkingTokens: 20,
        costMicros: 855,
        httpStatus: 200,
        lookId,
      }),
    ]);
    expect(await spentTodayMicros(ctx.db)).toBe(855);
  });

  it('never reads a photo twice unless asked, and a new reading replaces the old', async () => {
    const { mediaId } = await lookWithPhoto();
    const gemini = fakeGemini((_, i) =>
      geminiResponse(
        i === 0
          ? COAT_AND_SNEAKERS
          : { ...COAT_AND_SNEAKERS, garments: COAT_AND_SNEAKERS.garments.slice(0, 1) },
      ),
    );
    await spotPhoto(deps({ gemini: gemini.client }), mediaId);
    expect(await spotPhoto(deps({ gemini: gemini.client }), mediaId)).toEqual({
      outcome: 'skipped',
      reason: 'already spotted',
    });
    expect(gemini.calls).toHaveLength(1);

    await spotPhoto(deps({ gemini: gemini.client }), mediaId, { again: true });
    expect(gemini.calls).toHaveLength(2);
    expect((await liveGarments(mediaId)).map((g) => g.category)).toEqual(['coat']);
    const all = await ctx.db.select().from(garments).where(eq(garments.mediaId, mediaId));
    expect(all).toHaveLength(3); // the first two are soft-deleted
  });

  it('hides a flagged photo’s looks and queues one review item, even when retried', async () => {
    const { lookId, mediaId } = await lookWithPhoto();
    const draft = await createLook(ctx.db, { authorId, status: 'draft' });
    await ctx.db.insert(lookMedia).values({ lookId: draft, mediaId, position: 1 });
    const flagged = {
      ...COAT_AND_SNEAKERS,
      safety: { nudity: true, violence: false, spam_text: false },
    };
    const gemini = fakeGemini(() => geminiResponse(flagged));

    expect(await spotPhoto(deps({ gemini: gemini.client }), mediaId)).toMatchObject({
      outcome: 'flagged',
    });
    await spotPhoto(deps({ gemini: gemini.client }), mediaId, { again: true });

    const hidden = await ctx.db
      .select({ id: looks.id, status: looks.status })
      .from(looks)
      .where(sql`${looks.id} in (${lookId}, ${draft})`);
    expect(hidden.map((l) => l.status)).toEqual(['hidden', 'hidden']);
    const queue = await ctx.db
      .select()
      .from(moderationQueue)
      .where(eq(moderationQueue.mediaId, mediaId));
    expect(queue).toHaveLength(1);
    expect(queue[0]).toMatchObject({ kind: 'photo_flagged', status: 'open', reasons: ['nudity'] });
    expect((queue[0]?.details as { looks: unknown[] }).looks).toEqual(
      expect.arrayContaining([
        { id: lookId, previousStatus: 'published' },
        { id: draft, previousStatus: 'draft' },
      ]),
    );
    const [photo] = await ctx.db.select().from(media).where(eq(media.id, mediaId));
    expect(photo).toMatchObject({ spotStatus: 'flagged', safetyFlags: ['nudity'] });
  });

  it('treats a photo Gemini refuses to read as flagged ("blocked")', async () => {
    const { lookId, mediaId } = await lookWithPhoto();
    const gemini = fakeGemini(() =>
      json({
        promptFeedback: { blockReason: 'SAFETY' },
        usageMetadata: { promptTokenCount: 1200 },
      }),
    );
    expect(await spotPhoto(deps({ gemini: gemini.client }), mediaId)).toEqual({
      outcome: 'flagged',
      garments: 0,
      costMicros: 300,
    });
    const [look] = await ctx.db
      .select({ status: looks.status })
      .from(looks)
      .where(eq(looks.id, lookId));
    expect(look?.status).toBe('hidden');
    const [call] = await ctx.db.select().from(aiCalls).where(eq(aiCalls.mediaId, mediaId));
    expect(call).toMatchObject({ status: 'blocked', error: 'refused: SAFETY', costMicros: 300 });
  });

  it('stops before calling once today’s spending reaches the cap (yesterday’s doesn’t count)', async () => {
    const { mediaId } = await lookWithPhoto();
    const gemini = fakeGemini(() => geminiResponse(COAT_AND_SNEAKERS));
    const yesterday = new Date(Date.now() - 26 * 60 * 60 * 1000);
    await ctx.db.insert(aiCalls).values([
      {
        purpose: 'spot_garments',
        model: 'm',
        promptVersion: 'p',
        status: 'ok',
        costMicros: 9_000_000,
        durationMs: 1,
        createdAt: yesterday,
      },
      {
        purpose: 'spot_garments',
        model: 'm',
        promptVersion: 'p',
        status: 'ok',
        costMicros: 600_000,
        durationMs: 1,
      },
    ]);
    expect(await spentTodayMicros(ctx.db)).toBe(600_000);

    const capped = deps({ gemini: gemini.client, dailyCapMicros: 600_000 });
    const error = await spotPhoto(capped, mediaId).catch((e: unknown) => e);
    expect(error).toBeInstanceOf(SpendCapReachedError);
    expect(error).toMatchObject({ spentMicros: 600_000, capMicros: 600_000 });
    expect(gemini.calls).toHaveLength(0);

    await expect(
      spotPhoto(deps({ gemini: gemini.client, dailyCapMicros: 600_001 }), mediaId),
    ).resolves.toMatchObject({
      outcome: 'done',
    });
  });

  it('logs failed calls; passes on the ones worth retrying and marks the rest failed', async () => {
    const busy = await lookWithPhoto();
    const quota = fakeGemini(() => json({ error: { message: 'quota' } }, 429));
    await expect(spotPhoto(deps({ gemini: quota.client }), busy.mediaId)).rejects.toMatchObject({
      name: 'GeminiError',
      retryable: true,
    });
    const [photo] = await ctx.db.select().from(media).where(eq(media.id, busy.mediaId));
    expect(photo?.spotStatus).toBeNull(); // still to do

    const bad = await lookWithPhoto();
    const badRequest = fakeGemini(() => json({ error: { message: 'bad' } }, 400));
    expect(await spotPhoto(deps({ gemini: badRequest.client }), bad.mediaId)).toMatchObject({
      outcome: 'failed',
    });
    const [failed] = await ctx.db.select().from(media).where(eq(media.id, bad.mediaId));
    expect(failed?.spotStatus).toBe('failed');

    const calls = await ctx.db.select().from(aiCalls).orderBy(asc(aiCalls.createdAt));
    expect(calls.map((c) => [c.status, c.httpStatus, c.costMicros])).toEqual([
      ['failed', 429, 0],
      ['failed', 400, 0],
    ]);
  });

  it('logs an unusable answer (with its cost) and asks for a retry', async () => {
    const { mediaId } = await lookWithPhoto();
    const gemini = fakeGemini(() => geminiResponse('half an answer'));
    await expect(spotPhoto(deps({ gemini: gemini.client }), mediaId)).rejects.toBeInstanceOf(
      SpotAnswerError,
    );
    const [call] = await ctx.db.select().from(aiCalls).where(eq(aiCalls.mediaId, mediaId));
    expect(call).toMatchObject({ status: 'invalid', costMicros: 855 });
  });

  it('tries an answer cut off at the output limit once more, then gives up', async () => {
    const { mediaId } = await lookWithPhoto();
    const gemini = fakeGemini(() =>
      json({
        candidates: [
          { content: { parts: [{ text: '{"garments": [' }] }, finishReason: 'MAX_TOKENS' },
        ],
        usageMetadata: { promptTokenCount: 1500, candidatesTokenCount: 4096 },
      }),
    );
    await expect(spotPhoto(deps({ gemini: gemini.client }), mediaId)).rejects.toBeInstanceOf(
      SpotAnswerError,
    );
    expect(await spotPhoto(deps({ gemini: gemini.client }), mediaId)).toEqual({
      outcome: 'failed',
      reason: 'answers cut off at the output limit twice',
    });
    const calls = await ctx.db.select().from(aiCalls).where(eq(aiCalls.mediaId, mediaId));
    expect(calls.map((c) => [c.status, c.error, c.costMicros])).toEqual([
      ['invalid', 'MAX_TOKENS: unusable answer', 375 + 6144],
      ['invalid', 'MAX_TOKENS: unusable answer', 375 + 6144],
    ]);
    const [photo] = await ctx.db.select().from(media).where(eq(media.id, mediaId));
    expect(photo?.spotStatus).toBe('failed');
  });

  it('logs an estimated cost when the answer could not be read, and asks for a retry', async () => {
    const { mediaId } = await lookWithPhoto();
    const gemini = fakeGemini(() => new Response('<html>proxy error</html>', { status: 200 }));
    await expect(spotPhoto(deps({ gemini: gemini.client }), mediaId)).rejects.toMatchObject({
      name: 'GeminiError',
      retryable: true,
      maybeBilled: true,
    });
    const [call] = await ctx.db.select().from(aiCalls).where(eq(aiCalls.mediaId, mediaId));
    // 2,000 input tokens (a typical photo) + the 4,096 output tokens we allow.
    expect(call).toMatchObject({ status: 'failed', httpStatus: 200, costMicros: 500 + 6144 });
    expect(call?.error).toContain('(cost estimated)');
    expect(await spentTodayMicros(ctx.db)).toBe(6644);
  });

  it('keeps every photo’s words when two photos of one look are read at once', async () => {
    const first = await lookWithPhoto();
    const lookId = first.lookId;
    const second = await lookWithPhoto();
    await ctx.db.insert(lookMedia).values({ lookId, mediaId: second.mediaId, position: 1 });
    await ctx.storage.putPublic(
      `m/${second.mediaId}/1080.webp`,
      Buffer.from('second'),
      'image/webp',
    );
    // Both answers come back together, so both photos are saved at the same moment.
    let release: () => void = () => undefined;
    const bothAsked = new Promise<void>((resolve) => {
      release = resolve;
    });
    let asked = 0;
    const gemini = fakeGemini(async (call) => {
      asked += 1;
      if (asked === 2) release();
      await bothAsked;
      const body = call.body as { contents: { parts: { inlineData?: { data: string } }[] }[] };
      const isSecond =
        body.contents[0]?.parts[0]?.inlineData?.data === Buffer.from('second').toString('base64');
      return geminiResponse({
        ...COAT_AND_SNEAKERS,
        description: isSecond ? 'Second.' : 'First.',
        tags: isSecond ? ['boots'] : ['coat'],
      });
    });
    await Promise.all([
      spotPhoto(deps({ gemini: gemini.client }), first.mediaId),
      spotPhoto(deps({ gemini: gemini.client }), second.mediaId),
    ]);
    const [look] = await ctx.db.select().from(looks).where(eq(looks.id, lookId));
    expect(look).toMatchObject({ aiDescription: 'First.', aiTags: ['coat', 'boots'] });
  });

  it('leaves an already hidden look hidden, with no status of its own to restore', async () => {
    const { lookId, mediaId } = await lookWithPhoto();
    await ctx.db.update(looks).set({ status: 'hidden' }).where(eq(looks.id, lookId));
    const flagged = {
      ...COAT_AND_SNEAKERS,
      safety: { nudity: false, violence: true, spam_text: false },
    };
    const gemini = fakeGemini(() => geminiResponse(flagged));
    await spotPhoto(deps({ gemini: gemini.client }), mediaId);
    const [look] = await ctx.db
      .select({ status: looks.status })
      .from(looks)
      .where(eq(looks.id, lookId));
    expect(look?.status).toBe('hidden');
    const [item] = await ctx.db
      .select()
      .from(moderationQueue)
      .where(eq(moderationQueue.mediaId, mediaId));
    expect(item).toMatchObject({ status: 'open', reasons: ['violence'], details: { looks: [] } });
  });

  it('skips photos that are not in a look, not ready, or when Gemini is off', async () => {
    const { mediaId } = await lookWithPhoto();
    expect(await spotPhoto(deps(), mediaId)).toEqual({
      outcome: 'skipped',
      reason: 'no Gemini key',
    });
    await ctx.db.delete(lookMedia).where(eq(lookMedia.mediaId, mediaId));
    const gemini = fakeGemini(() => geminiResponse(COAT_AND_SNEAKERS));
    expect(await spotPhoto(deps({ gemini: gemini.client }), mediaId)).toEqual({
      outcome: 'skipped',
      reason: 'not in a look',
    });
    const processing = await createLook(ctx.db, { authorId, cover: 'processing' });
    const [link] = await ctx.db.select().from(lookMedia).where(eq(lookMedia.lookId, processing));
    expect(await spotPhoto(deps({ gemini: gemini.client }), link?.mediaId ?? '')).toEqual({
      outcome: 'skipped',
      reason: 'photo not ready',
    });
    expect(gemini.calls).toHaveLength(0);
  });

  it('gives a look the sentence of its first read photo and every photo’s words once', async () => {
    const { lookId, mediaId } = await lookWithPhoto();
    const second = await lookWithPhoto();
    await ctx.db.insert(lookMedia).values({ lookId, mediaId: second.mediaId, position: 1 });
    await ctx.db
      .update(media)
      .set({ aiDescription: null, aiTags: ['coat', 'beige'] })
      .where(eq(media.id, mediaId));
    await ctx.db
      .update(media)
      .set({ aiDescription: 'Second photo.', aiTags: ['beige', 'boots'] })
      .where(eq(media.id, second.mediaId));
    await refreshLookAi(ctx.db, lookId);
    const [look] = await ctx.db.select().from(looks).where(eq(looks.id, lookId));
    expect(look).toMatchObject({
      aiDescription: 'Second photo.',
      aiTags: ['coat', 'beige', 'boots'],
    });
  });
});

describe('finding photos read with older instructions', () => {
  it('goes by each photo’s last answered call, whatever came after it', async () => {
    const old = crypto.randomUUID();
    const current = crypto.randomUUID();
    const oldThenFailed = crypto.randomUUID();
    const newThenOld = crypto.randomUUID();
    const blockedOld = crypto.randomUUID();
    const linkOnly = crypto.randomUUID();
    const never = crypto.randomUUID();
    const at = (minute: number) => new Date(Date.UTC(2026, 10, 6, 3, minute));
    const call = (
      mediaId: string,
      promptVersion: string,
      minute: number,
      status: 'ok' | 'blocked' | 'invalid' | 'failed' = 'ok',
      purpose: 'spot_garments' | 'link_check' = 'spot_garments',
    ) => ({
      purpose,
      model: 'gemini-test',
      promptVersion,
      status,
      durationMs: 1,
      mediaId,
      createdAt: at(minute),
    });
    await ctx.db
      .insert(aiCalls)
      .values([
        call(old, 'spot-v1', 1),
        call(current, 'spot-v1', 1),
        call(current, SPOT_PROMPT_VERSION, 2),
        call(oldThenFailed, 'spot-v1', 1),
        call(oldThenFailed, SPOT_PROMPT_VERSION, 2, 'failed'),
        call(oldThenFailed, SPOT_PROMPT_VERSION, 3, 'invalid'),
        call(newThenOld, SPOT_PROMPT_VERSION, 1),
        call(newThenOld, 'spot-v1', 2),
        call(blockedOld, 'spot-v1', 1, 'blocked'),
        call(linkOnly, 'link-v1', 1, 'ok', 'link_check'),
      ]);
    const found = await readWithOlderInstructions(ctx.db, [
      old,
      current,
      oldThenFailed,
      newThenOld,
      blockedOld,
      linkOnly,
      never,
    ]);
    expect([...found].sort()).toEqual([old, oldThenFailed, newThenOld, blockedOld].sort());
    expect(await readWithOlderInstructions(ctx.db, [])).toEqual(new Set());
  });
});

describe('fingerprinting a look photo', () => {
  it('fingerprints the whole photo and each garment, and stores the model', async () => {
    const { mediaId } = await lookWithPhoto();
    const gemini = fakeGemini(() => geminiResponse(COAT_AND_SNEAKERS));
    await spotPhoto(deps({ gemini: gemini.client }), mediaId);
    const embedder = fakeEmbedder();
    expect(await fingerprintPhoto(deps({ embedder: embedder.client }), mediaId)).toEqual({
      outcome: 'done',
      fingerprints: 3,
      model: 'Marqo/marqo-fashionSigLIP@c56244c',
    });
    expect(embedder.calls[0]?.body).toEqual({
      url: `https://img.test/m/${mediaId}/1080.webp`,
      boxes: [
        { left: 0, top: 0, right: 1, bottom: 1 },
        { left: 0.2, top: 0.1, right: 0.8, bottom: 0.6 },
        { left: 0.3, top: 0.85, right: 0.7, bottom: 0.98 },
      ],
    });
    const [photo] = await ctx.db.select().from(media).where(eq(media.id, mediaId));
    expect(photo?.embedding?.[0]).toBe(1);
    expect(photo?.embeddingModel).toBe('Marqo/marqo-fashionSigLIP@c56244c');
    const pieces = await liveGarments(mediaId);
    expect(pieces.map((g) => [g.embedding?.[1], g.embedding?.[2], g.embeddingModel])).toEqual([
      [1, 0, 'Marqo/marqo-fashionSigLIP@c56244c'],
      [0, 1, 'Marqo/marqo-fashionSigLIP@c56244c'],
    ]);

    expect(await fingerprintPhoto(deps({ embedder: embedder.client }), mediaId)).toEqual({
      outcome: 'skipped',
      reason: 'already fingerprinted',
    });
    expect(embedder.calls).toHaveLength(1);
  });

  it('sends at most 20 boxes per call', async () => {
    const { mediaId } = await lookWithPhoto();
    await ctx.db.insert(garments).values(
      Array.from({ length: 24 }, (_, i) => ({
        mediaId,
        category: 'accessory' as const,
        boxLeft: 0,
        boxTop: i / 30,
        boxRight: 0.5,
        boxBottom: i / 30 + 0.02,
      })),
    );
    const embedder = fakeEmbedder();
    expect(await fingerprintPhoto(deps({ embedder: embedder.client }), mediaId)).toMatchObject({
      fingerprints: 25,
    });
    expect(embedder.calls.map((c) => (c.body as { boxes: unknown[] }).boxes.length)).toEqual([
      20, 5,
    ]);
    const left = await ctx.db
      .select({ id: garments.id })
      .from(garments)
      .where(and(eq(garments.mediaId, mediaId), isNull(garments.embedding)));
    expect(left).toHaveLength(0);
  });

  it('keeps the batches that finished when a later one fails', async () => {
    const { mediaId } = await lookWithPhoto();
    await ctx.db.insert(garments).values(
      Array.from({ length: 22 }, (_, i) => ({
        mediaId,
        category: 'accessory' as const,
        boxLeft: 0,
        boxTop: i / 30,
        boxRight: 0.5,
        boxBottom: i / 30 + 0.02,
      })),
    );
    const embedder = fakeEmbedder((call, i) =>
      i === 0
        ? json({
            model: 'm',
            embeddings: (call.body as { boxes: unknown[] }).boxes.map(() => unitVector(0)),
          })
        : json({}, 503),
    );
    await expect(
      fingerprintPhoto(deps({ embedder: embedder.client }), mediaId),
    ).rejects.toMatchObject({
      retryable: true,
    });
    const left = await ctx.db
      .select({ id: garments.id })
      .from(garments)
      .where(and(eq(garments.mediaId, mediaId), isNull(garments.embedding)));
    // The whole photo + 19 garments were saved; the retry only sends the last 3.
    expect(left).toHaveLength(3);
    const [photo] = await ctx.db
      .select({ m: media.embeddingModel })
      .from(media)
      .where(eq(media.id, mediaId));
    expect(photo?.m).toBe('m');
  });

  it('is skipped without the fingerprint service', async () => {
    const { mediaId } = await lookWithPhoto();
    expect(await fingerprintPhoto(deps(), mediaId)).toEqual({
      outcome: 'skipped',
      reason: 'no fingerprint service',
    });
  });
});

describe('queueing a ready photo', () => {
  it('asks for a reading (or only fingerprints without Gemini), only for look photos', async () => {
    const { mediaId } = await lookWithPhoto();
    const gemini = fakeGemini(() => geminiResponse(COAT_AND_SNEAKERS)).client;
    const embedder = fakeEmbedder().client;
    ctx.queued.length = 0;
    await queuePhotoAi(ctx.queue, ctx.db, { gemini, embedder, dailyCapMicros: 1 }, mediaId);
    await queuePhotoAi(ctx.queue, ctx.db, { gemini: null, embedder, dailyCapMicros: 1 }, mediaId);
    await queuePhotoAi(
      ctx.queue,
      ctx.db,
      { gemini: null, embedder: null, dailyCapMicros: 1 },
      mediaId,
    );
    await queuePhotoAi(ctx.queue, ctx.db, undefined, mediaId);
    await ctx.db.delete(lookMedia).where(eq(lookMedia.mediaId, mediaId));
    await queuePhotoAi(ctx.queue, ctx.db, { gemini, embedder, dailyCapMicros: 1 }, mediaId);
    expect(ctx.queued).toEqual([
      { name: QUEUES.photoSpot, data: { mediaId } },
      { name: QUEUES.photoFingerprint, data: { mediaId } },
    ]);
  });

  it('pauses until the next UTC day', () => {
    expect(nextUtcDay(new Date('2026-11-05T23:59:59Z')).toISOString()).toBe(
      '2026-11-06T00:00:00.000Z',
    );
    expect(nextUtcDay(new Date('2026-12-31T08:00:00Z')).toISOString()).toBe(
      '2027-01-01T00:00:00.000Z',
    );
  });
});
