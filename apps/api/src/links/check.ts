import {
  aiCalls,
  and,
  type Db,
  eq,
  inArray,
  isNull,
  linkChecks,
  lookItems,
  looks,
  media,
  moderationQueue,
  offers,
  products,
  sql,
} from '@outfitly/db';
import type { GarmentCategory, LinkCheckReason } from '@outfitly/shared';
import { z } from 'zod';
import { costMicros, type GeminiClient, GeminiError } from '../ai/gemini.ts';
import { SpendCapReachedError, spentTodayMicros } from '../ai/photos.ts';
import type { Box } from '../ai/spot.ts';
import type { JobQueue } from '../jobs.ts';
import { readSetting } from '../settings.ts';
import type { PhotoStorage } from '../storage.ts';
import {
  COMPARE_MAX_OUTPUT_TOKENS,
  COMPARE_PROMPT,
  COMPARE_PROMPT_VERSION,
  COMPARE_SCHEMA,
  type CompareAnswer,
  garmentCrop,
  parseCompareAnswer,
  smallPhoto,
} from './compare.ts';

export const LINK_CHECK_QUEUES = {
  /** Checks one look item's link: is the shop's product the piece in the photo? */
  linkCheck: 'link-check',
  /** Hourly: asks again about look items still waiting (a missed trigger, a key added later). */
  linkCheckSweep: 'link-check-sweep',
} as const;

/** The `settings` row with the score thresholds (inserted by migration 0015). */
export const THRESHOLDS_SETTING = 'link_check_thresholds';

export const thresholdsSchema = z
  .object({
    /** At least this alike: verified without asking the AI. */
    verifyAt: z.number().min(-1).max(1),
    /** Below this: rejected without asking the AI. */
    rejectBelow: z.number().min(-1).max(1),
  })
  .refine((t) => t.rejectBelow <= t.verifyAt, { error: 'rejectBelow must not exceed verifyAt' });
export type Thresholds = z.infer<typeof thresholdsSchema>;

export function linkCheckThresholds(db: Db): Promise<Thresholds> {
  return readSetting(db, THRESHOLDS_SETTING, thresholdsSchema);
}

export interface LinkCheckDeps {
  db: Db;
  storage: PhotoStorage;
  /** Off (null) without a key: items that need the AI wait. */
  gemini: GeminiClient | null;
  /** AI spending allowed per UTC day, in millionths of a dollar (shared with spotting). */
  dailyCapMicros: number;
}

export type LinkCheckDecision = 'verified' | 'rejected' | 'review';

export type LinkCheckOutcome =
  | {
      outcome: LinkCheckDecision;
      reason: LinkCheckReason | null;
      similarity: number | null;
      checkId: string;
    }
  /** Not decided yet: comes back when the missing part arrives (or with the hourly sweep). */
  | {
      outcome: 'waiting';
      reason:
        | 'product photo'
        | 'product fingerprint'
        | 'photo not read'
        | 'garment fingerprint'
        | 'models differ'
        | 'no Gemini key'
        | 'AI failed';
    }
  | { outcome: 'skipped'; reason: 'gone' | 'not pending' | 'changed meanwhile' };

/** Gemini's answer was unusable (not the promised JSON): worth another try. */
export class CompareAnswerError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'CompareAnswerError';
  }
}

/** A shop photo still missing this long after the product was read won't come: a person checks. */
const PRODUCT_PHOTO_WAIT_MS = 60 * 60 * 1000;
/** Our 1080 copies are a few hundred KB; anything near this is wrong. */
const MAX_PHOTO_BYTES = 5 * 1024 * 1024;
/** What a call we stopped waiting for may have cost: two small photos and the prompt. */
const ESTIMATED_INPUT_TOKENS = 1500;
/** Look items asked about again per sweep. */
const SWEEP_LIMIT = 500;

export interface Candidate {
  id: string;
  mediaId: string;
  category: GarmentCategory;
  box: Box;
  embeddingModel: string | null;
  hasFingerprint: boolean;
  similarity: number | null;
  /** Another live item of the same look already shows this garment. */
  taken: boolean;
}

type GarmentChoice = 'given' | 'dot' | 'nearest' | 'nearest in category';

type Decided = {
  outcome: LinkCheckDecision;
  reason: LinkCheckReason | null;
  similarity: number | null;
  garment: Candidate | null;
  choice: GarmentChoice | null;
  thresholds: Thresholds | null;
  ai: (CompareAnswer & { callId: string }) | null;
  /** The AI refused to answer (counts as unsure). */
  refusal?: string;
};

type Tx = Parameters<Parameters<Db['transaction']>[0]>[0];

/**
 * Checks one look item's link (Step 3.5), once per time it's pending:
 * - the offer is gone → rejected (`link_removed`); sold out → rejected (`sold_out`);
 * - the garment (the poster's, or the look's piece most like the product) and
 *   the product photo are compared by fingerprint: at least `verifyAt` alike →
 *   verified, below `rejectBelow` → rejected (`not_similar`), in between Gemini
 *   is asked: yes → verified, no → rejected (`ai_different`), unsure → review;
 * - no usable shop photo, or no piece found in the look → review.
 * Missing parts (photo not read yet, fingerprints, no Gemini key) leave it
 * pending (`waiting`): it's asked again when they arrive. Every decision is
 * saved in `link_checks`; review items also go to the review queue. Throws
 * `SpendCapReachedError` (try tomorrow) and errors worth retrying.
 */
export async function checkLookItem(
  deps: LinkCheckDeps,
  lookItemId: string,
): Promise<LinkCheckOutcome> {
  const { db } = deps;
  const [item] = await db
    .select({
      status: lookItems.status,
      itemDeleted: lookItems.deletedAt,
      lookId: lookItems.lookId,
      lookDeleted: looks.deletedAt,
      offerId: lookItems.offerId,
      garmentId: lookItems.garmentId,
      mediaId: lookItems.mediaId,
      dotX: lookItems.dotX,
      dotY: lookItems.dotY,
      offerDeleted: offers.deletedAt,
      stock: offers.stock,
      productId: offers.productId,
    })
    .from(lookItems)
    .innerJoin(looks, eq(looks.id, lookItems.lookId))
    .innerJoin(offers, eq(offers.id, lookItems.offerId))
    .where(eq(lookItems.id, lookItemId));
  if (!item || item.itemDeleted || item.lookDeleted) return { outcome: 'skipped', reason: 'gone' };
  if (item.status !== 'pending') return { outcome: 'skipped', reason: 'not pending' };
  const snapshot = { offerId: item.offerId, garmentId: item.garmentId };
  const save = (decided: Decided) => saveDecision(db, lookItemId, snapshot, item, decided);
  const plain = { similarity: null, garment: null, choice: null, thresholds: null, ai: null };

  const [product] = await db
    .select({
      deletedAt: products.deletedAt,
      category: products.category,
      imageUrl: products.imageUrl,
      updatedAt: products.updatedAt,
      photoStatus: media.status,
      photoKey: media.key1080,
      embeddingModel: products.embeddingModel,
      hasFingerprint: sql<boolean>`${products.embedding} is not null`,
    })
    .from(products)
    .leftJoin(media, and(eq(media.id, products.imageMediaId), isNull(media.deletedAt)))
    .where(eq(products.id, item.productId));
  if (item.offerDeleted || !product || product.deletedAt) {
    return save({ outcome: 'rejected', reason: 'link_removed', ...plain });
  }
  if (item.stock === 'out_of_stock')
    return save({ outcome: 'rejected', reason: 'sold_out', ...plain });

  // The shop's photo: copied in and fingerprinted, still on its way, or never coming.
  if (product.photoStatus !== 'ready' || !product.photoKey) {
    const onItsWay =
      product.imageUrl !== null &&
      product.photoStatus !== 'failed' &&
      Date.now() - product.updatedAt.getTime() < PRODUCT_PHOTO_WAIT_MS;
    if (onItsWay) return { outcome: 'waiting', reason: 'product photo' };
    return save({ outcome: 'review', reason: 'no_product_photo', ...plain });
  }
  if (!product.hasFingerprint) return { outcome: 'waiting', reason: 'product fingerprint' };

  const candidates = await garmentCandidates(db, item, lookItemId, item.productId);
  if (candidates.length === 0) {
    if (await unreadPhotos(db, item.lookId, item.mediaId)) {
      return { outcome: 'waiting', reason: 'photo not read' };
    }
    return save({ outcome: 'review', reason: 'no_garment', ...plain });
  }
  if (candidates.some((c) => !c.hasFingerprint)) {
    return { outcome: 'waiting', reason: 'garment fingerprint' };
  }
  if (candidates.some((c) => c.embeddingModel !== product.embeddingModel)) {
    // Fingerprints from different models can't be compared: one side must be redone first.
    return { outcome: 'waiting', reason: 'models differ' };
  }
  const { garment, choice } = chooseGarment(candidates, item, product.category);
  const similarity = garment.similarity ?? 0;

  const thresholds = await linkCheckThresholds(db);
  const scored = { similarity, garment, choice, thresholds };
  if (similarity >= thresholds.verifyAt) {
    return save({ outcome: 'verified', reason: null, ...scored, ai: null });
  }
  if (similarity < thresholds.rejectBelow) {
    return save({ outcome: 'rejected', reason: 'not_similar', ...scored, ai: null });
  }

  // In between: the AI looks at both photos. Never decided without it.
  const asked = await compareWithAi(deps, {
    lookId: item.lookId,
    garment,
    productPhotoKey: product.photoKey,
  });
  if ('waiting' in asked) return { outcome: 'waiting', reason: asked.waiting };
  if ('refusal' in asked) {
    return save({
      outcome: 'review',
      reason: 'ai_unsure',
      ...scored,
      ai: null,
      refusal: asked.refusal,
    });
  }
  const decision: Pick<Decided, 'outcome' | 'reason'> =
    asked.same === 'yes'
      ? { outcome: 'verified', reason: null }
      : asked.same === 'no'
        ? { outcome: 'rejected', reason: 'ai_different' }
        : { outcome: 'review', reason: 'ai_unsure' };
  return save({ ...decision, ...scored, ai: asked });
}

/**
 * The garments the item could be: the poster's own pick, else the pieces of
 * its photo (with a dot) or of all the look's photos, each with its
 * similarity to the product.
 */
async function garmentCandidates(
  db: Db,
  item: { lookId: string; garmentId: string | null; mediaId: string | null },
  lookItemId: string,
  productId: string,
): Promise<Candidate[]> {
  const read = (where: ReturnType<typeof sql>) =>
    db.execute<{
      id: string;
      media_id: string;
      category: GarmentCategory;
      box_left: number;
      box_top: number;
      box_right: number;
      box_bottom: number;
      embedding_model: string | null;
      has_fingerprint: boolean;
      similarity: number | null;
      taken: boolean;
    }>(
      sql`SELECT g.id, g.media_id, g.category, g.box_left, g.box_top, g.box_right, g.box_bottom,
                 g.embedding_model, g.embedding IS NOT NULL AS has_fingerprint,
                 CASE WHEN g.embedding IS NOT NULL AND p.embedding IS NOT NULL
                      THEN 1 - (g.embedding OPERATOR(extensions.<=>) p.embedding) END AS similarity,
                 EXISTS (SELECT 1 FROM look_items other
                          WHERE other.look_id = ${item.lookId} AND other.garment_id = g.id
                            AND other.id <> ${lookItemId} AND other.deleted_at IS NULL
                            AND other.status <> 'rejected') AS taken
            FROM garments g
            JOIN look_media lm ON lm.media_id = g.media_id AND lm.look_id = ${item.lookId}
            JOIN products p ON p.id = ${productId}
           WHERE g.deleted_at IS NULL AND ${where}
           ORDER BY g.id`,
    );
  const toCandidates = (rows: Awaited<ReturnType<typeof read>>['rows']): Candidate[] =>
    rows.map((r) => ({
      id: r.id,
      mediaId: r.media_id,
      category: r.category,
      box: { left: r.box_left, top: r.box_top, right: r.box_right, bottom: r.box_bottom },
      embeddingModel: r.embedding_model,
      hasFingerprint: r.has_fingerprint,
      similarity: r.similarity,
      taken: r.taken,
    }));

  if (item.garmentId) {
    // The poster's pick, if it's still one of the look's pieces (a re-read replaces garments).
    const given = toCandidates((await read(sql`g.id = ${item.garmentId}`)).rows);
    if (given.length > 0) return given;
  }
  const where = item.mediaId ? sql`g.media_id = ${item.mediaId}` : sql`TRUE`;
  return toCandidates((await read(where)).rows);
}

/**
 * Which garment the item is: the poster's pick; else the smallest piece under
 * the item's dot; else the piece most like the product (in the product's
 * category if it has one there), preferring pieces no other item shows.
 */
export function chooseGarment(
  candidates: Candidate[],
  item: {
    garmentId: string | null;
    mediaId: string | null;
    dotX: number | null;
    dotY: number | null;
  },
  productCategory: GarmentCategory | null,
): { garment: Candidate; choice: GarmentChoice } {
  const given = candidates.find((c) => c.id === item.garmentId);
  if (given) return { garment: given, choice: 'given' };

  const { dotX, dotY } = item;
  if (item.mediaId && dotX !== null && dotY !== null) {
    const area = (b: Box) => (b.right - b.left) * (b.bottom - b.top);
    const under = candidates
      .filter(
        (c) =>
          c.mediaId === item.mediaId &&
          dotX >= c.box.left &&
          dotX <= c.box.right &&
          dotY >= c.box.top &&
          dotY <= c.box.bottom,
      )
      .sort((a, b) => area(a.box) - area(b.box) || a.id.localeCompare(b.id));
    const [smallest] = under;
    if (smallest) return { garment: smallest, choice: 'dot' };
  }

  const free = candidates.filter((c) => !c.taken);
  const pool = free.length > 0 ? free : candidates;
  const inCategory = productCategory ? pool.filter((c) => c.category === productCategory) : [];
  const best = (list: Candidate[]) =>
    [...list].sort(
      (a, b) => (b.similarity ?? -2) - (a.similarity ?? -2) || a.id.localeCompare(b.id),
    )[0];
  const nearestInCategory = best(inCategory);
  if (nearestInCategory) return { garment: nearestInCategory, choice: 'nearest in category' };
  const nearest = best(pool);
  if (!nearest) throw new Error('No garment to choose from.');
  return { garment: nearest, choice: 'nearest' };
}

/** A photo of the look (or of the item's photo) that is ready but not read by the AI yet. */
async function unreadPhotos(db: Db, lookId: string, mediaId: string | null): Promise<boolean> {
  const { rows } = await db.execute<{ unread: boolean }>(
    sql`SELECT EXISTS (
          SELECT 1 FROM look_media lm JOIN media m ON m.id = lm.media_id
           WHERE lm.look_id = ${lookId} AND m.deleted_at IS NULL
             AND m.status IN ('pending', 'processing', 'ready') AND m.spot_status IS NULL
             AND (${mediaId}::uuid IS NULL OR m.id = ${mediaId}::uuid)) AS unread`,
  );
  return rows[0]?.unread ?? false;
}

export type Asked =
  | (CompareAnswer & { callId: string })
  | { refusal: string; callId: string }
  | { waiting: 'no Gemini key' | 'AI failed' };

/**
 * Shows Gemini the garment (cut from our photo) and the product photo, and
 * logs the call (also used by `pnpm links:calibrate --ai`).
 */
export async function compareWithAi(
  deps: LinkCheckDeps,
  input: { lookId: string; garment: Candidate; productPhotoKey: string },
): Promise<Asked> {
  const { db, gemini, storage } = deps;
  if (!gemini) return { waiting: 'no Gemini key' };
  const spent = await spentTodayMicros(db);
  if (spent >= deps.dailyCapMicros) throw new SpendCapReachedError(spent, deps.dailyCapMicros);

  const [look] = await db
    .select({ key1080: media.key1080 })
    .from(media)
    .where(eq(media.id, input.garment.mediaId));
  if (!look?.key1080) throw new Error('The look photo has no public copy.');
  const [piece, productPhoto] = await Promise.all([
    storage.getPublic(look.key1080, MAX_PHOTO_BYTES).then((p) => garmentCrop(p, input.garment.box)),
    storage.getPublic(input.productPhotoKey, MAX_PHOTO_BYTES).then(smallPhoto),
  ]);

  const log = {
    purpose: 'link_check' as const,
    model: gemini.model,
    promptVersion: COMPARE_PROMPT_VERSION,
    mediaId: input.garment.mediaId,
    lookId: input.lookId,
  };
  const started = performance.now();
  let answer;
  try {
    answer = await gemini.generateJson({
      prompt: COMPARE_PROMPT,
      images: [
        { label: 'Photo A (the piece in the outfit):', mimeType: 'image/webp', data: piece },
        { label: 'Photo B (the shop product):', mimeType: 'image/webp', data: productPhoto },
      ],
      schema: COMPARE_SCHEMA,
      maxOutputTokens: COMPARE_MAX_OUTPUT_TOKENS,
    });
  } catch (error) {
    if (!(error instanceof GeminiError)) throw error;
    const estimate = error.maybeBilled
      ? costMicros(gemini.model, {
          inputTokens: ESTIMATED_INPUT_TOKENS,
          outputTokens: COMPARE_MAX_OUTPUT_TOKENS,
          thinkingTokens: 0,
        })
      : 0;
    await db.insert(aiCalls).values({
      ...log,
      status: 'failed',
      costMicros: estimate,
      durationMs: Math.round(performance.now() - started),
      httpStatus: error.httpStatus,
      error: `${error.message}${error.maybeBilled ? ' (cost estimated)' : ''}`.slice(0, 500),
    });
    if (error.retryable) throw error;
    // A request Gemini refuses as wrong (bad key or settings) stays pending, never decided.
    return { waiting: 'AI failed' };
  }

  const parsed = answer.refusal === null ? parseCompareAnswer(answer.text ?? '') : null;
  const [call] = await db
    .insert(aiCalls)
    .values({
      ...log,
      modelVersion: answer.modelVersion,
      status: answer.refusal !== null ? 'blocked' : parsed ? 'ok' : 'invalid',
      inputTokens: answer.usage.inputTokens,
      outputTokens: answer.usage.outputTokens,
      thinkingTokens: answer.usage.thinkingTokens,
      costMicros: costMicros(gemini.model, answer.usage),
      durationMs: Math.round(performance.now() - started),
      httpStatus: 200,
      error:
        answer.refusal !== null
          ? `refused: ${answer.refusal}`
          : parsed
            ? null
            : `${answer.finishReason ?? 'NO_FINISH_REASON'}: unusable answer`,
    })
    .returning({ id: aiCalls.id });
  const callId = call?.id ?? '';
  if (answer.refusal !== null) return { refusal: answer.refusal, callId };
  if (!parsed) {
    throw new CompareAnswerError(`Unusable answer (finish: ${answer.finishReason ?? 'none'}).`);
  }
  return { ...parsed, callId };
}

/**
 * Saves one decision, once: only while the item is still pending with the
 * same offer and garment as when the check started (a change meanwhile
 * queues its own check, and a retry after this commits finds it decided).
 */
async function saveDecision(
  db: Db,
  lookItemId: string,
  snapshot: { offerId: string; garmentId: string | null },
  item: { lookId: string; productId: string },
  decided: Decided,
): Promise<LinkCheckOutcome> {
  return db.transaction(async (tx: Tx) => {
    const [now] = await tx
      .select({
        status: lookItems.status,
        offerId: lookItems.offerId,
        garmentId: lookItems.garmentId,
        deletedAt: lookItems.deletedAt,
      })
      .from(lookItems)
      .where(eq(lookItems.id, lookItemId))
      .for('update');
    if (!now || now.deletedAt) return { outcome: 'skipped', reason: 'gone' };
    if (now.status !== 'pending') return { outcome: 'skipped', reason: 'not pending' };
    if (now.offerId !== snapshot.offerId || now.garmentId !== snapshot.garmentId) {
      return { outcome: 'skipped', reason: 'changed meanwhile' };
    }

    const { garment, thresholds, ai } = decided;
    const [check] = await tx
      .insert(linkChecks)
      .values({
        lookItemId,
        similarity: decided.similarity,
        aiAnswer: ai?.same ?? null,
        outcome: decided.outcome,
        reason: decided.reason,
        details: {
          offerId: snapshot.offerId,
          productId: item.productId,
          garmentId: garment?.id ?? null,
          garmentChoice: decided.choice,
          thresholds,
          fingerprintModel: garment?.embeddingModel ?? null,
          ...(ai
            ? { aiCallId: ai.callId, aiReason: ai.reason, promptVersion: COMPARE_PROMPT_VERSION }
            : {}),
          ...(decided.refusal ? { aiRefusal: decided.refusal } : {}),
        },
      })
      .returning({ id: linkChecks.id });
    if (!check) throw new Error('Link check not saved.');

    await tx
      .update(lookItems)
      .set({
        status: decided.outcome,
        matchScore: decided.similarity,
        ...(garment ? { garmentId: garment.id } : {}),
      })
      .where(eq(lookItems.id, lookItemId));

    if (decided.outcome === 'review') {
      await tx
        .insert(moderationQueue)
        .values({
          kind: 'link_check',
          lookItemId,
          details: { checkId: check.id, reason: decided.reason, similarity: decided.similarity },
        })
        .onConflictDoNothing({
          target: [moderationQueue.kind, moderationQueue.lookItemId],
          where: sql`status = 'open'`,
        });
    }
    if (decided.outcome === 'verified' && garment) {
      // A product's category comes from the first piece it's verified as.
      await tx
        .update(products)
        .set({ category: garment.category })
        .where(and(eq(products.id, item.productId), isNull(products.category)));
    }
    return {
      outcome: decided.outcome,
      reason: decided.reason,
      similarity: decided.similarity,
      checkId: check.id,
    };
  });
}

export interface NewLookItem {
  lookId: string;
  offerId: string;
  /** The poster's pick of the AI's pieces, when they made one. */
  garmentId?: string | null;
  /** Where the poster put the dot: one of the look's photos, in fractions of it. */
  dot?: { mediaId: string; x: number; y: number } | null;
}

/**
 * Puts an offer on a look (or back, if it was removed) as pending and queues
 * its check. An item already on the look is left as it is. Returns its id
 * and whether a check was queued.
 */
export async function addLookItem(
  db: Db,
  queue: JobQueue,
  input: NewLookItem,
): Promise<{ id: string; queued: boolean }> {
  const fields = {
    garmentId: input.garmentId ?? null,
    mediaId: input.dot?.mediaId ?? null,
    dotX: input.dot?.x ?? null,
    dotY: input.dot?.y ?? null,
  };
  const [row] = await db
    .insert(lookItems)
    .values({ lookId: input.lookId, offerId: input.offerId, ...fields, status: 'pending' })
    .onConflictDoUpdate({
      target: [lookItems.lookId, lookItems.offerId],
      // Only a removed item starts over; a live one keeps its check.
      set: {
        status: sql`CASE WHEN ${lookItems.deletedAt} IS NULL THEN ${lookItems.status} ELSE 'pending' END`,
        matchScore: sql`CASE WHEN ${lookItems.deletedAt} IS NULL THEN ${lookItems.matchScore} END`,
        garmentId: sql`CASE WHEN ${lookItems.deletedAt} IS NULL THEN ${lookItems.garmentId} ELSE excluded.garment_id END`,
        mediaId: sql`CASE WHEN ${lookItems.deletedAt} IS NULL THEN ${lookItems.mediaId} ELSE excluded.media_id END`,
        dotX: sql`CASE WHEN ${lookItems.deletedAt} IS NULL THEN ${lookItems.dotX} ELSE excluded.dot_x END`,
        dotY: sql`CASE WHEN ${lookItems.deletedAt} IS NULL THEN ${lookItems.dotY} ELSE excluded.dot_y END`,
        deletedAt: null,
      },
    })
    .returning({ id: lookItems.id, status: lookItems.status });
  if (!row) throw new Error('Look item not saved.');
  if (row.status !== 'pending') return { id: row.id, queued: false };
  await queueLinkCheck(queue, row.id);
  return { id: row.id, queued: true };
}

export async function queueLinkCheck(queue: JobQueue, lookItemId: string): Promise<void> {
  await queue.send(LINK_CHECK_QUEUES.linkCheck, { lookItemId }, { singletonKey: lookItemId });
}

async function queueAll(queue: JobQueue, ids: string[]): Promise<number> {
  for (const id of ids) await queueLinkCheck(queue, id);
  return ids.length;
}

/** After a photo's garments were fingerprinted: its looks' items still waiting. */
export async function queueChecksForPhoto(
  queue: JobQueue,
  db: Db,
  mediaId: string,
): Promise<number> {
  const { rows } = await db.execute<{ id: string }>(
    sql`SELECT DISTINCT li.id FROM look_items li
          JOIN look_media lm ON lm.look_id = li.look_id
         WHERE lm.media_id = ${mediaId} AND li.status = 'pending' AND li.deleted_at IS NULL
         ORDER BY li.id`,
  );
  return queueAll(
    queue,
    rows.map((r) => r.id),
  );
}

/** After a product's photo was copied in (or refused) or fingerprinted: its items still waiting. */
export async function queueChecksForProduct(
  queue: JobQueue,
  db: Db,
  productId: string,
): Promise<number> {
  const rows = await db
    .select({ id: lookItems.id })
    .from(lookItems)
    .innerJoin(offers, eq(offers.id, lookItems.offerId))
    .where(
      and(
        eq(offers.productId, productId),
        eq(lookItems.status, 'pending'),
        isNull(lookItems.deletedAt),
      ),
    )
    .orderBy(lookItems.id);
  return queueAll(
    queue,
    rows.map((r) => r.id),
  );
}

/**
 * Puts the given items back to pending (their product changed: a link that
 * now shows another item) and returns the ids to check. The poster's garment
 * pick and dot stay.
 */
export async function recheckLookItems(tx: Db | Tx, offerIds: string[]): Promise<string[]> {
  if (offerIds.length === 0) return [];
  const rows = await tx
    .update(lookItems)
    .set({ status: 'pending', matchScore: null })
    .where(and(inArray(lookItems.offerId, offerIds), isNull(lookItems.deletedAt)))
    .returning({ id: lookItems.id });
  return rows.map((r) => r.id);
}

/** Hourly: items still pending (oldest first), asked about again. */
export async function sweepPendingChecks(queue: JobQueue, db: Db): Promise<number> {
  const rows = await db
    .select({ id: lookItems.id })
    .from(lookItems)
    .innerJoin(looks, eq(looks.id, lookItems.lookId))
    .where(
      and(eq(lookItems.status, 'pending'), isNull(lookItems.deletedAt), isNull(looks.deletedAt)),
    )
    .orderBy(lookItems.updatedAt)
    .limit(SWEEP_LIMIT);
  return queueAll(
    queue,
    rows.map((r) => r.id),
  );
}
