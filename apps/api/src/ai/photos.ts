import {
  aiCalls,
  and,
  asc,
  type Db,
  eq,
  garments,
  inArray,
  isNull,
  lookMedia,
  looks,
  media,
  moderationQueue,
  sql,
} from '@outfitly/db';
import type { SafetyFlag } from '@outfitly/shared';
import type { PhotoStorage } from '../storage.ts';
import { type EmbedderClient, MAX_BOXES_PER_CALL } from './embedder.ts';
import { costMicros, type GeminiClient, GeminiError } from './gemini.ts';
import {
  type Box,
  parseSpotAnswer,
  SPOT_MAX_OUTPUT_TOKENS,
  SPOT_PROMPT,
  SPOT_PROMPT_VERSION,
  SPOT_SCHEMA,
  type SpotResult,
} from './spot.ts';

/** What reading a look's photo needs. A missing client turns that part off. */
export interface PhotoAiDeps {
  db: Db;
  storage: PhotoStorage;
  gemini: GeminiClient | null;
  embedder: EmbedderClient | null;
  /** AI spending allowed per UTC day, in millionths of a dollar. */
  dailyCapMicros: number;
}

/** Today's AI spending reached the cap: try again tomorrow. */
export class SpendCapReachedError extends Error {
  readonly spentMicros: number;
  readonly capMicros: number;

  constructor(spentMicros: number, capMicros: number) {
    super(
      `Daily AI spend cap reached: $${(spentMicros / 1e6).toFixed(2)} of $${(capMicros / 1e6).toFixed(2)}.`,
    );
    this.name = 'SpendCapReachedError';
    this.spentMicros = spentMicros;
    this.capMicros = capMicros;
  }
}

/** Gemini's answer was unusable (not the promised JSON): worth one more try. */
export class SpotAnswerError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'SpotAnswerError';
  }
}

type Tx = Parameters<Parameters<Db['transaction']>[0]>[0];

/** Our 1080 copy is at most a few hundred KB; anything near this is wrong. */
const MAX_PHOTO_BYTES = 5 * 1024 * 1024;
/** Search words kept per look, across its photos. */
const MAX_LOOK_TAGS = 20;

/** The next 00:00 UTC, when the daily cap starts over. */
export function nextUtcDay(now = new Date()): Date {
  return new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate() + 1));
}

/** AI spending so far today (UTC), in millionths of a dollar. */
export async function spentTodayMicros(db: Db): Promise<number> {
  const { rows } = await db.execute<{ spent: string }>(
    sql`SELECT coalesce(sum(cost_micros), 0)::text AS spent FROM ai_calls
         WHERE created_at >= date_trunc('day', now(), 'UTC')`,
  );
  return Number(rows[0]?.spent ?? 0);
}

/** The looks (not deleted) a photo belongs to. */
export async function looksOfPhoto(db: Db | Tx, mediaId: string): Promise<string[]> {
  const rows = await db
    .select({ id: looks.id })
    .from(lookMedia)
    .innerJoin(looks, eq(looks.id, lookMedia.lookId))
    .where(and(eq(lookMedia.mediaId, mediaId), isNull(looks.deletedAt)))
    .orderBy(asc(looks.createdAt));
  return rows.map((r) => r.id);
}

export type SpotOutcome =
  | { outcome: 'done' | 'flagged'; garments: number; costMicros: number }
  | { outcome: 'failed'; reason: string }
  | { outcome: 'skipped'; reason: string };

/**
 * Reads one of a look's photos with Gemini (once: results are kept, never
 * re-run unless `again`), stores its garments, sentence, search words and
 * safety flags, and hides its looks if it's flagged. Logs the call and its
 * cost. Throws `SpendCapReachedError` without calling when today's cap is
 * reached, and errors worth retrying (`GeminiError` with `retryable`,
 * `SpotAnswerError`) for the job to retry.
 */
export async function spotPhoto(
  deps: PhotoAiDeps,
  mediaId: string,
  options: { again?: boolean } = {},
): Promise<SpotOutcome> {
  const { db, gemini } = deps;
  const [photo] = await db
    .select({ status: media.status, key1080: media.key1080, spotStatus: media.spotStatus })
    .from(media)
    .where(and(eq(media.id, mediaId), isNull(media.deletedAt)));
  if (!photo || photo.status !== 'ready' || !photo.key1080) {
    return { outcome: 'skipped', reason: 'photo not ready' };
  }
  if (!options.again && (photo.spotStatus === 'done' || photo.spotStatus === 'flagged')) {
    return { outcome: 'skipped', reason: 'already spotted' };
  }
  const lookIds = await looksOfPhoto(db, mediaId);
  if (lookIds.length === 0) return { outcome: 'skipped', reason: 'not in a look' };
  if (!gemini) return { outcome: 'skipped', reason: 'no Gemini key' };

  const spent = await spentTodayMicros(db);
  if (spent >= deps.dailyCapMicros) throw new SpendCapReachedError(spent, deps.dailyCapMicros);

  const image = await deps.storage.getPublic(photo.key1080, MAX_PHOTO_BYTES);
  const log = {
    purpose: 'spot_garments' as const,
    model: gemini.model,
    promptVersion: SPOT_PROMPT_VERSION,
    mediaId,
    lookId: lookIds[0] ?? null,
  };
  const started = performance.now();
  let answer;
  try {
    answer = await gemini.generateJson({
      prompt: SPOT_PROMPT,
      image: { mimeType: 'image/webp', data: image },
      schema: SPOT_SCHEMA,
      maxOutputTokens: SPOT_MAX_OUTPUT_TOKENS,
    });
  } catch (error) {
    if (!(error instanceof GeminiError)) throw error;
    await db.insert(aiCalls).values({
      ...log,
      status: 'failed',
      durationMs: Math.round(performance.now() - started),
      httpStatus: error.httpStatus,
      error: error.message.slice(0, 500),
    });
    if (error.retryable) throw error;
    await db
      .update(media)
      .set({ spotStatus: 'failed', spottedAt: new Date() })
      .where(eq(media.id, mediaId));
    return { outcome: 'failed', reason: error.message };
  }

  const cost = costMicros(gemini.model, answer.usage);
  const result: SpotResult | null =
    answer.refusal === null
      ? parseSpotAnswer(answer.text ?? '')
      : { garments: [], description: null, tags: [], flags: ['blocked'] };
  await db.insert(aiCalls).values({
    ...log,
    modelVersion: answer.modelVersion,
    status: answer.refusal !== null ? 'blocked' : result ? 'ok' : 'invalid',
    inputTokens: answer.usage.inputTokens,
    outputTokens: answer.usage.outputTokens,
    thinkingTokens: answer.usage.thinkingTokens,
    costMicros: cost,
    durationMs: Math.round(performance.now() - started),
    httpStatus: 200,
    error:
      answer.refusal !== null
        ? `refused: ${answer.refusal}`
        : result
          ? null
          : `unusable answer (finish: ${answer.finishReason ?? 'none'})`,
  });
  if (!result) {
    throw new SpotAnswerError(`Unusable answer (finish: ${answer.finishReason ?? 'none'}).`);
  }

  await saveSpotResult(db, mediaId, result);
  return {
    outcome: result.flags.length > 0 ? 'flagged' : 'done',
    garments: result.garments.length,
    costMicros: cost,
  };
}

/** Stores one reading of a photo (replacing an earlier one) and updates its looks. */
async function saveSpotResult(db: Db, mediaId: string, result: SpotResult): Promise<void> {
  await db.transaction(async (tx) => {
    // Lock the photo: a retry racing this one waits, then replaces cleanly.
    await tx.execute(sql`SELECT 1 FROM media WHERE id = ${mediaId} FOR UPDATE`);
    await tx
      .update(garments)
      .set({ deletedAt: new Date() })
      .where(and(eq(garments.mediaId, mediaId), isNull(garments.deletedAt)));
    if (result.garments.length > 0) {
      await tx.insert(garments).values(
        result.garments.map((g) => ({
          mediaId,
          category: g.category,
          color: g.color,
          attributes: g.attributes,
          boxLeft: g.box.left,
          boxTop: g.box.top,
          boxRight: g.box.right,
          boxBottom: g.box.bottom,
        })),
      );
    }
    await tx
      .update(media)
      .set({
        spotStatus: result.flags.length > 0 ? 'flagged' : 'done',
        spottedAt: new Date(),
        aiDescription: result.description,
        aiTags: result.tags,
        safetyFlags: result.flags,
      })
      .where(eq(media.id, mediaId));

    if (result.flags.length > 0) await holdForReview(tx, mediaId, result.flags);
    for (const lookId of await looksOfPhoto(tx, mediaId)) await refreshLookAi(tx, lookId);
  });
}

/** Hides every look the photo is in and opens one review item (kept on retries). */
async function holdForReview(tx: Tx, mediaId: string, flags: SafetyFlag[]): Promise<void> {
  const { rows: hidden } = await tx.execute<{ id: string; previous: string }>(
    sql`WITH target AS (
          SELECT l.id, l.status FROM looks l
            JOIN look_media lm ON lm.look_id = l.id
           WHERE lm.media_id = ${mediaId} AND l.deleted_at IS NULL AND l.status <> 'hidden'
             FOR UPDATE OF l)
        UPDATE looks SET status = 'hidden', updated_at = now()
          FROM target WHERE looks.id = target.id
        RETURNING looks.id, target.status::text AS previous`,
  );
  await tx
    .insert(moderationQueue)
    .values({
      kind: 'photo_flagged',
      mediaId,
      reasons: flags,
      // Each look's status before, so approving can put it back.
      details: { looks: hidden.map((r) => ({ id: r.id, previousStatus: r.previous })) },
    })
    .onConflictDoNothing({
      target: [moderationQueue.kind, moderationQueue.mediaId],
      where: sql`status = 'open'`,
    });
}

/**
 * A look's AI sentence comes from its first photo that has one; its search
 * words are its photos' words in photo order, without repeats.
 */
export async function refreshLookAi(db: Db | Tx, lookId: string): Promise<void> {
  const photos = await db
    .select({ description: media.aiDescription, tags: media.aiTags })
    .from(lookMedia)
    .innerJoin(media, eq(media.id, lookMedia.mediaId))
    .where(and(eq(lookMedia.lookId, lookId), isNull(media.deletedAt)))
    .orderBy(asc(lookMedia.position));
  const description = photos.find((p) => p.description)?.description ?? null;
  const tags: string[] = [];
  for (const tag of photos.flatMap((p) => p.tags)) {
    if (tags.length >= MAX_LOOK_TAGS) break;
    if (!tags.includes(tag)) tags.push(tag);
  }
  await db
    .update(looks)
    .set({ aiDescription: description, aiTags: tags })
    .where(eq(looks.id, lookId));
}

export type FingerprintOutcome =
  { outcome: 'done'; fingerprints: number; model: string } | { outcome: 'skipped'; reason: string };

/**
 * Fingerprints a photo: the whole photo (if it has none yet) and each of its
 * garments without one, in one call per 20 boxes. Throws `EmbedderError`.
 */
export async function fingerprintPhoto(
  deps: PhotoAiDeps,
  mediaId: string,
): Promise<FingerprintOutcome> {
  const { db, embedder } = deps;
  if (!embedder) return { outcome: 'skipped', reason: 'no fingerprint service' };
  const [photo] = await db
    .select({
      status: media.status,
      key1080: media.key1080,
      hasFingerprint: sql<boolean>`${media.embedding} is not null`,
    })
    .from(media)
    .where(and(eq(media.id, mediaId), isNull(media.deletedAt)));
  if (!photo || photo.status !== 'ready' || !photo.key1080) {
    return { outcome: 'skipped', reason: 'photo not ready' };
  }
  const pieces = await db
    .select({
      id: garments.id,
      left: garments.boxLeft,
      top: garments.boxTop,
      right: garments.boxRight,
      bottom: garments.boxBottom,
    })
    .from(garments)
    .where(
      and(eq(garments.mediaId, mediaId), isNull(garments.deletedAt), isNull(garments.embedding)),
    )
    // Top to bottom, so calls (and tests) always send the boxes in the same order.
    .orderBy(asc(garments.boxTop), asc(garments.boxLeft), asc(garments.id));

  const jobs: { garmentId: string | null; box: Box }[] = [
    ...(photo.hasFingerprint
      ? []
      : [{ garmentId: null, box: { left: 0, top: 0, right: 1, bottom: 1 } }]),
    ...pieces.map(({ id, ...box }) => ({ garmentId: id, box })),
  ];
  if (jobs.length === 0) return { outcome: 'skipped', reason: 'already fingerprinted' };

  const url = deps.storage.publicUrl(photo.key1080);
  const results: { garmentId: string | null; embedding: number[]; model: string }[] = [];
  for (let from = 0; from < jobs.length; from += MAX_BOXES_PER_CALL) {
    const chunk = jobs.slice(from, from + MAX_BOXES_PER_CALL);
    const answer = await embedder.embedImage(
      url,
      chunk.map((j) => j.box),
    );
    chunk.forEach((job, i) => {
      const embedding = answer.embeddings[i];
      if (embedding) results.push({ garmentId: job.garmentId, embedding, model: answer.model });
    });
  }

  await db.transaction(async (tx) => {
    for (const r of results) {
      if (r.garmentId === null) {
        await tx
          .update(media)
          .set({ embedding: r.embedding, embeddingModel: r.model })
          .where(eq(media.id, mediaId));
      } else {
        await tx
          .update(garments)
          .set({ embedding: r.embedding, embeddingModel: r.model })
          .where(eq(garments.id, r.garmentId));
      }
    }
  });
  return { outcome: 'done', fingerprints: results.length, model: results[0]?.model ?? '' };
}

/** Photos of these looks that still need reading or fingerprints (for the backfill script). */
export async function photosOfLooks(db: Db, lookIds: readonly string[]): Promise<string[]> {
  if (lookIds.length === 0) return [];
  const rows = await db
    .select({ mediaId: lookMedia.mediaId })
    .from(lookMedia)
    .where(inArray(lookMedia.lookId, [...lookIds]))
    .orderBy(asc(lookMedia.lookId), asc(lookMedia.position));
  return rows.map((r) => r.mediaId);
}
