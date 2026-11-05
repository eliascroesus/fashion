import { aiCalls, and, eq, garments, isNull, lookMedia, media } from '@outfitly/db';
import type { PgBoss } from 'pg-boss';
import sharp from 'sharp';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { nextUtcDay } from '../src/ai/photos.ts';
import { createJobQueue, QUEUES, startJobs } from '../src/jobs.ts';
import { COAT_AND_SNEAKERS, fakeEmbedder, fakeGemini, geminiResponse, json } from './ai-fakes.ts';
import { createAuthor, createLook } from './feed-fixtures.ts';
import { createTestContext, type TestContext } from './helpers.ts';

let ctx: TestContext;
let boss: PgBoss;
let authorId: string;
const logged: unknown[] = [];
const log = {
  info: (obj: unknown) => logged.push(obj),
  error: (obj: unknown, msg?: string) => logged.push({ ...(obj as object), msg }),
} as unknown as Parameters<typeof startJobs>[1]['log'];

/** Photos whose id is in here get a Gemini error 500 every time. */
const broken = new Set<string>();
let currentMedia = '';
const gemini = fakeGemini(() =>
  broken.has(currentMedia)
    ? json({ error: { message: 'boom' } }, 500)
    : geminiResponse(COAT_AND_SNEAKERS),
);
const embedder = fakeEmbedder();
const ai = { gemini: gemini.client, embedder: embedder.client, dailyCapMicros: 5_000_000 };

beforeAll(async () => {
  ctx = await createTestContext();
  authorId = await createAuthor(ctx.db, 'job.spotter');
  boss = createJobQueue(ctx.testDb.url);
  await startJobs(boss, {
    db: ctx.db,
    storage: ctx.storage,
    log,
    pollingIntervalSeconds: 0.5,
    ai,
    aiRetryDelaySeconds: 0,
  });
});

afterAll(async () => {
  await boss.stop({ graceful: false, close: true });
  await ctx.close();
});

async function photoInLook(): Promise<string> {
  const lookId = await createLook(ctx.db, { authorId });
  const [link] = await ctx.db
    .select({ mediaId: lookMedia.mediaId })
    .from(lookMedia)
    .where(eq(lookMedia.lookId, lookId));
  if (!link) throw new Error('look has no photo');
  await ctx.storage.putPublic(`m/${link.mediaId}/1080.webp`, Buffer.from('webp'), 'image/webp');
  currentMedia = link.mediaId;
  return link.mediaId;
}

describe('photo AI jobs', () => {
  it('read a photo, then fingerprint it and its garments', async () => {
    const mediaId = await photoInLook();
    await boss.send(QUEUES.photoSpot, { mediaId }, { singletonKey: mediaId });
    await expect
      .poll(
        async () => {
          const pieces = await ctx.db
            .select({ model: garments.embeddingModel })
            .from(garments)
            .where(and(eq(garments.mediaId, mediaId), isNull(garments.deletedAt)));
          const [photo] = await ctx.db
            .select({ model: media.embeddingModel, spot: media.spotStatus })
            .from(media)
            .where(eq(media.id, mediaId));
          return { pieces: pieces.map((p) => p.model), photo };
        },
        { timeout: 15_000 },
      )
      .toEqual({
        pieces: ['Marqo/marqo-fashionSigLIP@c56244c', 'Marqo/marqo-fashionSigLIP@c56244c'],
        photo: { model: 'Marqo/marqo-fashionSigLIP@c56244c', spot: 'done' },
      });
  });

  it('start reading a look photo as soon as its upload is processed', async () => {
    const lookId = await createLook(ctx.db, { authorId, cover: 'processing' });
    const [link] = await ctx.db
      .select({ mediaId: lookMedia.mediaId })
      .from(lookMedia)
      .where(eq(lookMedia.lookId, lookId));
    const mediaId = link?.mediaId ?? '';
    currentMedia = mediaId;
    const upload = await sharp({
      create: { width: 60, height: 80, channels: 3, background: '#a08870' },
    })
      .jpeg()
      .toBuffer();
    ctx.storage.simulateUpload(`originals/${mediaId}`, upload);
    await boss.send(QUEUES.mediaProcess, { mediaId }, { singletonKey: mediaId });
    await expect
      .poll(
        async () =>
          (
            await ctx.db
              .select({ spot: media.spotStatus, model: media.embeddingModel })
              .from(media)
              .where(eq(media.id, mediaId))
          )[0],
        { timeout: 20_000 },
      )
      .toEqual({ spot: 'done', model: 'Marqo/marqo-fashionSigLIP@c56244c' });
  });

  it('pause a photo until tomorrow (UTC) once the daily cap is reached', async () => {
    const mediaId = await photoInLook();
    await ctx.db.insert(aiCalls).values({
      purpose: 'spot_garments',
      model: 'gemini-3.1-flash-lite',
      promptVersion: 'spot-v1',
      status: 'ok',
      costMicros: 5_000_000,
      durationMs: 1,
    });
    const callsBefore = gemini.calls.length;
    const first = await boss.send(QUEUES.photoSpot, { mediaId }, { singletonKey: mediaId });
    if (!first) throw new Error('job was not created');
    await expect
      .poll(async () => (await boss.findJobs(QUEUES.photoSpot, { id: first }))[0]?.state, {
        timeout: 15_000,
      })
      .toBe('completed');
    const waiting = (await boss.findJobs(QUEUES.photoSpot, { key: mediaId })).filter(
      (j) => j.state === 'created',
    );
    expect(waiting).toHaveLength(1);
    expect(waiting[0]?.startAfter.getTime()).toBe(nextUtcDay().getTime());
    expect(gemini.calls.length).toBe(callsBefore);
    expect(logged).toContainEqual(
      expect.objectContaining({
        msg: 'daily AI spend cap reached: photo reading paused until 00:00 UTC',
      }),
    );
    await ctx.db.delete(aiCalls);
  });

  it('mark a photo failed once its retries run out', async () => {
    const mediaId = await photoInLook();
    broken.add(mediaId);
    await boss.send(QUEUES.photoSpot, { mediaId }, { singletonKey: mediaId });
    await expect
      .poll(
        async () =>
          (await ctx.db.select({ s: media.spotStatus }).from(media).where(eq(media.id, mediaId)))[0]
            ?.s,
        { timeout: 30_000 },
      )
      .toBe('failed');
    // The first try and three retries, each logged.
    const calls = await ctx.db.select().from(aiCalls).where(eq(aiCalls.mediaId, mediaId));
    expect(calls.map((c) => [c.status, c.httpStatus])).toEqual(Array(4).fill(['failed', 500]));
  });
});
