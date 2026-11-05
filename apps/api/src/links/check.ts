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

/** The same rules guard the database value and `pnpm links:calibrate --set`. */
export const thresholdsSchema = z
  .object({
    /** At least this alike: verified without asking the AI. */
    verifyAt: z.number().min(0.5).max(1),
    /** Below this: rejected without asking the AI. */
    rejectBelow: z.number().min(0).max(1),
  })
  .refine((t) => t.rejectBelow < t.verifyAt, { error: 'rejectBelow must be below verifyAt' });
export type Thresholds = z.infer<typeof thresholdsSchema>;

export function linkCheckThresholds(db: Db): Promise<Thresholds> {
  return readSetting(db, THRESHOLDS_SETTING, thresholdsSchema);
}

/** What the fingerprints alone decide: `ask` = in between, the AI looks. */
export function decideByScore(
  similarity: number,
  thresholds: Thresholds,
): 'verified' | 'rejected' | 'ask' {
  if (similarity >= thresholds.verifyAt) return 'verified';
  if (similarity < thresholds.rejectBelow) return 'rejected';
  return 'ask';
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

type WaitingFor =
  | 'product photo'
  | 'product fingerprint'
  | 'photo not read'
  | 'garment fingerprint'
  | 'models differ'
  | 'no Gemini key'
  | 'AI failed';

export type LinkCheckOutcome =
  | {
      outcome: LinkCheckDecision;
      reason: LinkCheckReason | null;
      similarity: number | null;
      checkId: string;
    }
  /** Not decided yet: comes back when the missing part arrives (or with the hourly sweep). */
  | { outcome: 'waiting'; reason: WaitingFor }
  | { outcome: 'skipped'; reason: 'gone' | 'not pending' | 'changed meanwhile' };

/** Gemini's answer was unusable (not the promised JSON): tried again later (the sweep), not now. */
export class CompareAnswerError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'CompareAnswerError';
  }
}

/** Something changed while the item was being checked (its garment taken or replaced): check again now. */
export class RecheckNowError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'RecheckNowError';
  }
}

/** A shop photo still missing this long after the link was read won't come: a person checks. */
const PRODUCT_PHOTO_WAIT_MS = 60 * 60 * 1000;
/**
 * Waiting this long for a fingerprint, for fingerprints from the same model,
 * or for the AI to accept our request means it won't come by itself: a person
 * checks (`check_failed`). Waiting for the photo to be read or for a Gemini
 * key has no limit: those are the whole system's state, not this item's.
 */
const MAX_WAIT_MS = 3 * 24 * 60 * 60 * 1000;
/** Paid AI answers we couldn't use (cut off, not JSON, timed out) before a person decides. */
const MAX_PAID_AI_FAILURES = 2;
/** Our 1080 copies are a few hundred KB; anything near this is wrong. */
const MAX_PHOTO_BYTES = 5 * 1024 * 1024;
/** What a call we stopped waiting for may have cost: two small photos and the prompt. */
const ESTIMATED_INPUT_TOKENS = 1500;
/** Look items asked about again per sweep, and how long one just tried is left alone. */
const SWEEP_LIMIT = 500;
const SWEEP_REST_MS = 30 * 60 * 1000;

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

export type GarmentChoice = 'given' | 'dot' | 'nearest' | 'nearest in category';

type Decided = {
  outcome: LinkCheckDecision;
  reason: LinkCheckReason | null;
  similarity: number | null;
  garment: Candidate | null;
  choice: GarmentChoice | null;
  thresholds: Thresholds | null;
  ai: (CompareAnswer & { callId: string }) | null;
  /** Anything else worth keeping in `link_checks.details`. */
  extra?: Record<string, unknown>;
};

/** What the item looked like when its check started: a decision is only saved if it still does. */
interface Snapshot {
  offerId: string;
  garmentId: string | null;
  productId: string;
  productPhotoId: string | null;
}

type Tx = Parameters<Parameters<Db['transaction']>[0]>[0];

/**
 * Checks one look item's link (Step 3.5), once per time it's pending:
 * - the offer is gone → rejected (`link_removed`); sold out → rejected (`sold_out`);
 * - the garment (the poster's pick, the piece under their dot, or the piece
 *   most like the product, once every photo it could be on is read) and the
 *   product photo are compared by fingerprint: at least `verifyAt` alike →
 *   verified, below `rejectBelow` → rejected (`not_similar`), in between
 *   Gemini is asked: yes → verified, no → rejected (`ai_different`), unsure →
 *   review;
 * - no usable shop photo, no piece found, a dot on no piece, or something
 *   that never comes → review.
 * Missing parts (photos not read yet, fingerprints, no Gemini key) leave it
 * pending (`waiting`): it's asked again when they arrive. Every decision is
 * saved in `link_checks`; review items also go to the review queue. Throws
 * `SpendCapReachedError` (try tomorrow), `CompareAnswerError` (try later),
 * `RecheckNowError` and other errors worth retrying.
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
      pendingSince: lookItems.pendingSince,
      offerDeleted: offers.deletedAt,
      offerReadAt: offers.lastCheckedAt,
      stock: offers.stock,
      productId: offers.productId,
    })
    .from(lookItems)
    .innerJoin(looks, eq(looks.id, lookItems.lookId))
    .innerJoin(offers, eq(offers.id, lookItems.offerId))
    .where(eq(lookItems.id, lookItemId));
  if (!item || item.itemDeleted || item.lookDeleted) return { outcome: 'skipped', reason: 'gone' };
  if (item.status !== 'pending') return { outcome: 'skipped', reason: 'not pending' };
  // Tried now: the hourly sweep asks about the least recently tried first.
  await db
    .update(lookItems)
    .set({ checkedAt: sql`now()` })
    .where(eq(lookItems.id, lookItemId));

  const [product] = await db
    .select({
      deletedAt: products.deletedAt,
      category: products.category,
      imageUrl: products.imageUrl,
      imageMediaId: products.imageMediaId,
      imageFailedAt: products.imageFailedAt,
      photoStatus: media.status,
      photoKey: media.key1080,
      embeddingModel: products.embeddingModel,
      hasFingerprint: sql<boolean>`${products.embedding} is not null`,
    })
    .from(products)
    .leftJoin(media, and(eq(media.id, products.imageMediaId), isNull(media.deletedAt)))
    .where(eq(products.id, item.productId));
  const snapshot: Snapshot = {
    offerId: item.offerId,
    garmentId: item.garmentId,
    productId: item.productId,
    productPhotoId: product?.imageMediaId ?? null,
  };
  const save = (decided: Decided) => saveDecision(db, lookItemId, item.lookId, snapshot, decided);
  const plain = { similarity: null, garment: null, choice: null, thresholds: null, ai: null };
  const pendingFor = Date.now() - (item.pendingSince?.getTime() ?? Date.now());
  /** Waits, unless it has waited too long for something that should have come by now. */
  const wait = (reason: WaitingFor): Promise<LinkCheckOutcome> | LinkCheckOutcome =>
    pendingFor < MAX_WAIT_MS
      ? { outcome: 'waiting', reason }
      : save({ outcome: 'review', reason: 'check_failed', ...plain, extra: { waitedFor: reason } });

  if (item.offerDeleted || !product || product.deletedAt) {
    return save({ outcome: 'rejected', reason: 'link_removed', ...plain });
  }
  if (item.stock === 'out_of_stock') {
    return save({ outcome: 'rejected', reason: 'sold_out', ...plain });
  }

  // The shop's photo: copied in and fingerprinted, still on its way, or never coming.
  if (product.photoStatus !== 'ready' || !product.photoKey) {
    const onItsWay =
      product.imageUrl !== null &&
      product.imageFailedAt === null &&
      product.photoStatus !== 'failed' &&
      item.offerReadAt !== null &&
      Date.now() - item.offerReadAt.getTime() < PRODUCT_PHOTO_WAIT_MS;
    if (onItsWay) return { outcome: 'waiting', reason: 'product photo' };
    return save({ outcome: 'review', reason: 'no_product_photo', ...plain });
  }
  if (!product.hasFingerprint) return wait('product fingerprint');

  const found = await garmentCandidates(db, item, lookItemId, item.productId);
  if (found.unread) return { outcome: 'waiting', reason: 'photo not read' };
  const { candidates } = found;
  if (candidates.length === 0) return save({ outcome: 'review', reason: 'no_garment', ...plain });
  if (candidates.some((c) => !c.hasFingerprint)) return wait('garment fingerprint');
  // Fingerprints from different models can't be compared: one side must be redone first.
  if (candidates.some((c) => c.embeddingModel !== product.embeddingModel)) {
    return wait('models differ');
  }
  const chosen = chooseGarment(candidates, item, product.category);
  if (!chosen) return save({ outcome: 'review', reason: 'dot_not_on_piece', ...plain });
  const { garment, choice } = chosen;
  const similarity = garment.similarity ?? 0;

  const thresholds = await linkCheckThresholds(db);
  const scored = { similarity, garment, choice, thresholds };
  const byScore = decideByScore(similarity, thresholds);
  if (byScore === 'verified')
    return save({ outcome: 'verified', reason: null, ...scored, ai: null });
  if (byScore === 'rejected') {
    return save({ outcome: 'rejected', reason: 'not_similar', ...scored, ai: null });
  }

  // In between: the AI looks at both photos. Never decided without it.
  if (!deps.gemini) return { outcome: 'waiting', reason: 'no Gemini key' };
  const failures = await paidAiFailures(db, lookItemId, item.pendingSince);
  if (failures >= MAX_PAID_AI_FAILURES) {
    return save({
      outcome: 'review',
      reason: 'ai_unsure',
      ...scored,
      ai: null,
      extra: { aiFailures: failures },
    });
  }
  let asked: Asked;
  try {
    asked = await compareWithAi(deps, {
      lookId: item.lookId,
      lookItemId,
      garment,
      productPhotoKey: product.photoKey,
    });
  } catch (error) {
    // The second unusable paid answer: a person decides instead of paying again.
    if (error instanceof CompareAnswerError && failures + 1 >= MAX_PAID_AI_FAILURES) {
      return save({
        outcome: 'review',
        reason: 'ai_unsure',
        ...scored,
        ai: null,
        extra: { aiFailures: failures + 1 },
      });
    }
    throw error;
  }
  if ('waiting' in asked) return wait(asked.waiting);
  if ('failed' in asked) {
    return save({
      outcome: 'review',
      reason: 'check_failed',
      ...scored,
      ai: null,
      extra: { problem: asked.failed },
    });
  }
  if ('refusal' in asked) {
    return save({
      outcome: 'review',
      reason: 'ai_unsure',
      ...scored,
      ai: null,
      extra: { aiCallId: asked.callId, aiRefusal: asked.refusal },
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

/** Paid link check answers for this item we couldn't use, since it last started waiting. */
async function paidAiFailures(db: Db, lookItemId: string, since: Date | null): Promise<number> {
  const { rows } = await db.execute<{ n: number }>(
    sql`SELECT count(*)::int AS n FROM ai_calls
         WHERE look_item_id = ${lookItemId}
           AND (status = 'invalid' OR (status = 'failed' AND cost_micros > 0))
           AND created_at >= ${(since ?? new Date(0)).toISOString()}`,
  );
  return rows[0]?.n ?? 0;
}

/**
 * The garments the item could be, each with its similarity to the product:
 * the poster's pick if it's still one of the look's pieces; else the pieces
 * of the dot's photo, or of all the look's photos. `unread` when one of
 * those photos isn't read by the AI yet (its piece might be the one).
 */
export async function garmentCandidates(
  db: Db,
  item: { lookId: string; garmentId: string | null; mediaId: string | null },
  lookItemId: string,
  productId: string,
): Promise<{ candidates: Candidate[]; unread: boolean }> {
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
                          WHERE other.look_id = ${item.lookId}
                            AND coalesce(other.garment_id, other.matched_garment_id) = g.id
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
    // The poster's pick: nothing else to wait for (a re-read may have replaced it, though).
    const given = toCandidates((await read(sql`g.id = ${item.garmentId}`)).rows);
    if (given.length > 0) return { candidates: given, unread: false };
  }
  if (await unreadPhotos(db, item.lookId, item.mediaId)) return { candidates: [], unread: true };
  const where = item.mediaId ? sql`g.media_id = ${item.mediaId}` : sql`TRUE`;
  return { candidates: toCandidates((await read(where)).rows), unread: false };
}

/**
 * Which garment the item is: the poster's pick; else, with a dot, the
 * smallest piece under it (null when the dot is on no piece); else the piece
 * most like the product (in the product's category if it has one there),
 * preferring pieces no other item shows.
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
): { garment: Candidate; choice: GarmentChoice } | null {
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
    // The poster pointed somewhere the AI found nothing: don't guess another piece.
    return smallest ? { garment: smallest, choice: 'dot' } : null;
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
  return nearest ? { garment: nearest, choice: 'nearest' } : null;
}

/** A photo in scope (the dot's, else all the look's) that isn't ready or read by the AI yet. */
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
  /** The photos can't be used (a person decides). */
  | { failed: string }
  | { waiting: 'no Gemini key' | 'AI failed' };

/**
 * Shows Gemini the garment (cut from our photo) and the product photo, and
 * logs the call (also used by `pnpm links:calibrate --ai`). Its own settings:
 * little thinking, the model's own image detail, a small answer.
 */
export async function compareWithAi(
  deps: LinkCheckDeps,
  input: {
    lookId: string;
    lookItemId: string | null;
    garment: Candidate;
    productPhotoKey: string;
  },
): Promise<Asked> {
  const { db, gemini, storage } = deps;
  if (!gemini) return { waiting: 'no Gemini key' };
  const spent = await spentTodayMicros(db);
  if (spent >= deps.dailyCapMicros) throw new SpendCapReachedError(spent, deps.dailyCapMicros);

  const [look] = await db
    .select({ key1080: media.key1080 })
    .from(media)
    .where(
      and(eq(media.id, input.garment.mediaId), eq(media.status, 'ready'), isNull(media.deletedAt)),
    );
  if (!look?.key1080) return { failed: 'the look photo is gone' };
  // Storage trouble may pass (thrown, retried); a picture we can't cut up won't.
  const [lookPhoto, productPhoto] = await Promise.all([
    storage.getPublic(look.key1080, MAX_PHOTO_BYTES),
    storage.getPublic(input.productPhotoKey, MAX_PHOTO_BYTES),
  ]);
  let piece: Buffer;
  let product: Buffer;
  try {
    [piece, product] = await Promise.all([
      garmentCrop(lookPhoto, input.garment.box),
      smallPhoto(productPhoto),
    ]);
  } catch (error) {
    return { failed: `photo unusable: ${(error as Error).message}`.slice(0, 200) };
  }

  const log = {
    purpose: 'link_check' as const,
    model: gemini.model,
    promptVersion: COMPARE_PROMPT_VERSION,
    mediaId: input.garment.mediaId,
    lookId: input.lookId,
    lookItemId: input.lookItemId,
  };
  const started = performance.now();
  let answer;
  try {
    answer = await gemini.generateJson({
      prompt: COMPARE_PROMPT,
      images: [
        { label: 'Photo A (the piece in the outfit):', mimeType: 'image/webp', data: piece },
        { label: 'Photo B (the shop product):', mimeType: 'image/webp', data: product },
      ],
      schema: COMPARE_SCHEMA,
      maxOutputTokens: COMPARE_MAX_OUTPUT_TOKENS,
      thinkingLevel: 'MINIMAL',
      mediaResolution: 'MODEL_DEFAULT',
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
    // A possibly billed call counts towards giving up; a busy or down Gemini is just retried.
    if (error.maybeBilled) throw new CompareAnswerError(error.message);
    if (error.retryable) throw error;
    // A request Gemini refuses as wrong (bad key or settings) waits, never decided.
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
 * same offer, poster's pick, product and product photo as when the check
 * started (a change meanwhile queues its own check, and a retry after this
 * commits finds it decided). Two items of a look don't claim the same free
 * piece at once, and a piece replaced meanwhile (a re-read) means checking
 * again (`RecheckNowError`).
 */
async function saveDecision(
  db: Db,
  lookItemId: string,
  lookId: string,
  snapshot: Snapshot,
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
    const [link] = await tx
      .select({ productId: offers.productId, photoId: products.imageMediaId })
      .from(offers)
      .innerJoin(products, eq(products.id, offers.productId))
      .where(eq(offers.id, now.offerId));
    const changed =
      !link ||
      now.offerId !== snapshot.offerId ||
      now.garmentId !== snapshot.garmentId ||
      link.productId !== snapshot.productId ||
      link.photoId !== snapshot.productPhotoId;
    if (changed) return { outcome: 'skipped', reason: 'changed meanwhile' };

    const { garment, thresholds, ai } = decided;
    if (garment) {
      // One item of a look decides at a time, so two can't claim the same free piece.
      await tx.execute(sql`SELECT pg_advisory_xact_lock(hashtext(${`look-items:${lookId}`}))`);
      const { rows } = await tx.execute<{ live: boolean; taken: boolean }>(
        sql`SELECT g.deleted_at IS NULL AS live,
                   EXISTS (SELECT 1 FROM look_items other
                            WHERE other.look_id = ${lookId}
                              AND coalesce(other.garment_id, other.matched_garment_id) = g.id
                              AND other.id <> ${lookItemId} AND other.deleted_at IS NULL
                              AND other.status <> 'rejected') AS taken
              FROM garments g WHERE g.id = ${garment.id} FOR SHARE OF g`,
      );
      const state = rows[0];
      if (!state?.live) throw new RecheckNowError('The matched piece was replaced meanwhile.');
      const pickedByUs = decided.choice === 'nearest' || decided.choice === 'nearest in category';
      if (pickedByUs && state.taken && !garment.taken) {
        throw new RecheckNowError('Another item took the matched piece meanwhile.');
      }
    }

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
          productId: snapshot.productId,
          garmentId: garment?.id ?? null,
          garmentChoice: decided.choice,
          thresholds,
          fingerprintModel: garment?.embeddingModel ?? null,
          ...(ai
            ? { aiCallId: ai.callId, aiReason: ai.reason, promptVersion: COMPARE_PROMPT_VERSION }
            : {}),
          ...decided.extra,
        },
      })
      .returning({ id: linkChecks.id });
    if (!check) throw new Error('Link check not saved.');

    // The poster's own pick (garment_id) is never overwritten: the check's is matched_garment_id.
    await tx
      .update(lookItems)
      .set({
        status: decided.outcome,
        matchScore: decided.similarity,
        matchedGarmentId: garment?.id ?? null,
        pendingSince: null,
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
    } else {
      await closeLinkReviews(tx, [lookItemId], 'decided by the automatic check');
    }
    if (decided.outcome === 'verified' && garment && !ai) {
      // A product's category comes from the first piece its fingerprint clearly matches.
      await tx
        .update(products)
        .set({ category: garment.category })
        .where(and(eq(products.id, snapshot.productId), isNull(products.category)));
    }
    return {
      outcome: decided.outcome,
      reason: decided.reason,
      similarity: decided.similarity,
      checkId: check.id,
    };
  });
}

/** Open link check review items of these look items, closed: the question is gone or changed. */
async function closeLinkReviews(tx: Db | Tx, lookItemIds: string[], note: string): Promise<void> {
  if (lookItemIds.length === 0) return;
  await tx
    .update(moderationQueue)
    .set({ status: 'removed', resolvedAt: sql`now()`, note })
    .where(
      and(
        eq(moderationQueue.kind, 'link_check'),
        eq(moderationQueue.status, 'open'),
        inArray(moderationQueue.lookItemId, lookItemIds),
      ),
    );
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
  const removed = sql`${lookItems.deletedAt} IS NOT NULL`;
  const [row] = await db
    .insert(lookItems)
    .values({ lookId: input.lookId, offerId: input.offerId, ...fields, status: 'pending' })
    .onConflictDoUpdate({
      target: [lookItems.lookId, lookItems.offerId],
      // Only a removed item starts over; a live one keeps its check.
      set: {
        status: sql`CASE WHEN ${removed} THEN 'pending' ELSE ${lookItems.status} END`,
        matchScore: sql`CASE WHEN ${removed} THEN NULL ELSE ${lookItems.matchScore} END`,
        matchedGarmentId: sql`CASE WHEN ${removed} THEN NULL ELSE ${lookItems.matchedGarmentId} END`,
        pendingSince: sql`CASE WHEN ${removed} THEN now() ELSE ${lookItems.pendingSince} END`,
        garmentId: sql`CASE WHEN ${removed} THEN excluded.garment_id ELSE ${lookItems.garmentId} END`,
        mediaId: sql`CASE WHEN ${removed} THEN excluded.media_id ELSE ${lookItems.mediaId} END`,
        dotX: sql`CASE WHEN ${removed} THEN excluded.dot_x ELSE ${lookItems.dotX} END`,
        dotY: sql`CASE WHEN ${removed} THEN excluded.dot_y ELSE ${lookItems.dotY} END`,
        deletedAt: null,
      },
    })
    .returning({ id: lookItems.id, status: lookItems.status });
  if (!row) throw new Error('Look item not saved.');
  if (row.status !== 'pending') return { id: row.id, queued: false };
  await queueLinkCheck(queue, row.id);
  return { id: row.id, queued: true };
}

/** Takes items off their looks; their open review items close. */
export async function removeLookItems(db: Db | Tx, lookItemIds: string[]): Promise<void> {
  if (lookItemIds.length === 0) return;
  await db
    .update(lookItems)
    .set({ deletedAt: sql`now()` })
    .where(and(inArray(lookItems.id, lookItemIds), isNull(lookItems.deletedAt)));
  await closeLinkReviews(db, lookItemIds, 'item removed from the look');
}

export async function queueLinkCheck(queue: JobQueue, lookItemId: string): Promise<void> {
  await queue.send(LINK_CHECK_QUEUES.linkCheck, { lookItemId }, { singletonKey: lookItemId });
}

async function queueAll(queue: JobQueue, ids: string[]): Promise<number> {
  for (const id of ids) await queueLinkCheck(queue, id);
  return ids.length;
}

/** After a photo was read or fingerprinted: its looks' items still waiting. */
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
 * The items showing these offers start over (their link now shows another
 * item): back to pending, the check's matched piece and score cleared, open
 * review items closed. The poster's own pick and dot stay. Returns the ids to
 * check.
 */
export async function recheckLookItems(tx: Db | Tx, offerIds: string[]): Promise<string[]> {
  if (offerIds.length === 0) return [];
  const rows = await tx
    .update(lookItems)
    .set({ status: 'pending', matchScore: null, matchedGarmentId: null, pendingSince: sql`now()` })
    .where(and(inArray(lookItems.offerId, offerIds), isNull(lookItems.deletedAt)))
    .returning({ id: lookItems.id });
  const ids = rows.map((r) => r.id);
  await closeLinkReviews(tx, ids, 'the link now shows another item');
  return ids;
}

/**
 * Hourly: items still pending, least recently tried first (none tried in the
 * last half hour), asked about again.
 */
export async function sweepPendingChecks(queue: JobQueue, db: Db): Promise<number> {
  const { rows } = await db.execute<{ id: string }>(
    sql`SELECT li.id FROM look_items li JOIN looks l ON l.id = li.look_id
         WHERE li.status = 'pending' AND li.deleted_at IS NULL AND l.deleted_at IS NULL
           AND (li.checked_at IS NULL
                OR li.checked_at < ${new Date(Date.now() - SWEEP_REST_MS).toISOString()})
         ORDER BY li.checked_at NULLS FIRST, li.id
         LIMIT ${SWEEP_LIMIT}`,
  );
  return queueAll(
    queue,
    rows.map((r) => r.id),
  );
}
