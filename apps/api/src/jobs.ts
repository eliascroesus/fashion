import {
  and,
  type Db,
  ensureEventPartitions,
  eq,
  idempotencyKeys,
  isNull,
  lt,
  media,
  sql,
} from '@outfitly/db';
import type { FastifyBaseLogger } from 'fastify';
import { PgBoss } from 'pg-boss';
import type { PhotoAiClients } from './ai/clients.ts';
import { EmbedderError } from './ai/embedder.ts';
import {
  fingerprintPhoto,
  looksOfPhoto,
  nextUtcDay,
  type PhotoAiDeps,
  SpendCapReachedError,
  spotPhoto,
} from './ai/photos.ts';
import { deleteOldSeen } from './events.ts';
import { deleteOldFeedSnapshots, recomputePopularity } from './feed/popularity.ts';
import { ImageRejectedError } from './media/image.ts';
import { refreshSearchTerms } from './search.ts';
import { markMediaFailed, processUploadedMedia } from './media/pipeline.ts';
import type { PhotoStorage } from './storage.ts';

export const QUEUES = {
  /** Does nothing but log; proves the job system works end to end. */
  ping: 'system-ping',
  idempotencyCleanup: 'idempotency-cleanup',
  /** Makes the `events` partitions for this month and the next two. */
  eventPartitions: 'event-partitions',
  /** Makes the public sizes of one uploaded photo. */
  mediaProcess: 'media-process',
  /** Photos whose processing ran out of retries (or crashed); marks them failed. */
  mediaProcessFailed: 'media-process-failed',
  /** Recomputes every look's popularity score (saves per view). */
  feedPopularity: 'feed-popularity',
  /** Deletes For You lists older than a day (hourly). */
  feedSnapshotCleanup: 'feed-snapshot-cleanup',
  /** Deletes "seen" rows older than a week (daily); the feed only looks back 7 days. */
  seenCleanup: 'seen-cleanup',
  /** Rebuilds search's vocabulary (typos, suggestions, popular tags) from the looks. */
  searchTerms: 'search-terms',
  /** Reads one of a look's photos with Gemini: garments, sentence, search words, safety. */
  photoSpot: 'photo-spot',
  /** Photos whose reading ran out of retries; marks them failed. */
  photoSpotFailed: 'photo-spot-failed',
  /** Fingerprints a photo and its garments (services/embedder). */
  photoFingerprint: 'photo-fingerprint',
} as const;

/** What routes need to enqueue work. */
export type JobQueue = Pick<PgBoss, 'send'>;

/**
 * The job queue (pg-boss: jobs live in Postgres, schema `pgboss`). Use
 * Supabase's direct or session connection: pg-boss breaks behind the
 * transaction pooler.
 */
export function createJobQueue(databaseUrl: string, caCert?: string): PgBoss {
  return new PgBoss({
    connectionString: databaseUrl,
    ssl: caCert ? { ca: caCert } : undefined,
    schema: 'pgboss',
    application_name: 'outfitly-api-jobs',
    max: 3,
  });
}

export interface WorkerDeps {
  db: Db;
  storage: PhotoStorage;
  log: FastifyBaseLogger;
  pollingIntervalSeconds?: number;
  /** Seconds between photo-processing retries (tests use 0). */
  mediaRetryDelaySeconds?: number;
  /** Gemini and the fingerprint service (either may be off), and the daily AI spend cap. */
  ai?: PhotoAiClients;
  /** Seconds before the first AI retry; later ones wait longer (tests use 0). */
  aiRetryDelaySeconds?: number;
}

/**
 * After one of a look's photos is ready: read it with Gemini (which then
 * fingerprints it), or, without Gemini, at least fingerprint the whole photo.
 * Photos that aren't in a look (yet) are left alone.
 */
export async function queuePhotoAi(
  queue: JobQueue,
  db: Db,
  ai: PhotoAiClients | undefined,
  mediaId: string,
): Promise<void> {
  if (!ai || (!ai.gemini && !ai.embedder)) return;
  if ((await looksOfPhoto(db, mediaId)).length === 0) return;
  await queue.send(
    ai.gemini ? QUEUES.photoSpot : QUEUES.photoFingerprint,
    { mediaId },
    {
      singletonKey: mediaId,
    },
  );
}

/** Starts the queue and every worker. */
export async function startJobs(boss: PgBoss, options: WorkerDeps): Promise<void> {
  const { db, storage, log } = options;
  boss.on('error', (err) => {
    log.error({ err }, 'job system error');
  });
  await boss.start();

  const workOptions = { pollingIntervalSeconds: options.pollingIntervalSeconds ?? 2 };

  await boss.createQueue(QUEUES.ping);
  await boss.work(QUEUES.ping, workOptions, async (jobs) => {
    for (const job of jobs) log.info({ jobId: job.id, data: job.data }, 'ping job ran');
    return Promise.resolve({ pong: true });
  });

  await boss.createQueue(QUEUES.idempotencyCleanup);
  await boss.work(QUEUES.idempotencyCleanup, workOptions, async () => {
    const deleted = await db
      .delete(idempotencyKeys)
      .where(lt(idempotencyKeys.expiresAt, sql`now()`))
      .returning({ id: idempotencyKeys.id });
    log.info({ deleted: deleted.length }, 'expired idempotency keys removed');
    return { deleted: deleted.length };
  });
  await boss.schedule(QUEUES.idempotencyCleanup, '17 3 * * *');

  await boss.createQueue(QUEUES.eventPartitions);
  await boss.work(QUEUES.eventPartitions, workOptions, async () => {
    const created = await ensureEventPartitions(db);
    if (created.length > 0) log.info({ created }, 'event partitions created');
    return { created };
  });
  // Also sent at every startup: a sleeping staging machine misses the daily run.
  await boss.schedule(QUEUES.eventPartitions, '7 2 * * *');

  await boss.createQueue(QUEUES.feedPopularity);
  await boss.work(QUEUES.feedPopularity, workOptions, async () => {
    const changed = await recomputePopularity(db);
    log.info({ changed }, 'popularity scores recomputed');
    return { changed };
  });
  await boss.schedule(QUEUES.feedPopularity, '*/15 * * * *');

  await boss.createQueue(QUEUES.feedSnapshotCleanup);
  await boss.work(QUEUES.feedSnapshotCleanup, workOptions, async () => {
    const deleted = await deleteOldFeedSnapshots(db);
    log.info({ deleted }, 'old feed lists removed');
    return { deleted };
  });
  await boss.schedule(QUEUES.feedSnapshotCleanup, '37 * * * *');

  await boss.createQueue(QUEUES.seenCleanup);
  await boss.work(QUEUES.seenCleanup, workOptions, async () => {
    const deleted = await deleteOldSeen(db);
    log.info({ deleted }, 'old seen rows removed');
    return { deleted };
  });
  await boss.schedule(QUEUES.seenCleanup, '47 3 * * *');

  await boss.createQueue(QUEUES.searchTerms);
  await boss.work(QUEUES.searchTerms, workOptions, async () => {
    const result = await refreshSearchTerms(db);
    log.info(result, 'search words refreshed');
    return result;
  });
  // Also sent at every startup, like the event partitions.
  await boss.schedule(QUEUES.searchTerms, '*/15 * * * *');

  await boss.createQueue(QUEUES.mediaProcessFailed);
  await boss.work<{ mediaId: string }>(QUEUES.mediaProcessFailed, workOptions, async (jobs) => {
    for (const { data } of jobs) {
      await markMediaFailed(db, data.mediaId, 'Processing failed after retries.');
    }
  });
  await boss.createQueue(QUEUES.mediaProcess, {
    // One job per photo at a time: sends with the photo id as singletonKey are deduplicated.
    policy: 'exclusive',
    retryLimit: 2,
    retryDelay: options.mediaRetryDelaySeconds ?? 10,
    // A job that crashed its worker is retried after this; then it goes to the failed queue.
    expireInSeconds: 300,
    deadLetter: QUEUES.mediaProcessFailed,
  });
  await boss.work<{ mediaId: string }>(QUEUES.mediaProcess, workOptions, async (jobs) => {
    for (const { data } of jobs) {
      try {
        await processUploadedMedia(db, storage, data.mediaId);
        log.info({ mediaId: data.mediaId }, 'photo processed');
        await queuePhotoAi(boss, db, options.ai, data.mediaId);
      } catch (error) {
        log.error({ err: error, mediaId: data.mediaId }, 'photo failed');
        // A photo we can't use won't get better with retries; anything else is retried.
        if (!(error instanceof ImageRejectedError)) throw error;
        await markMediaFailed(db, data.mediaId, error.message);
      }
    }
  });

  await startPhotoAiJobs(boss, options);
}

/** Garment spotting and fingerprints (Step 3.3). */
async function startPhotoAiJobs(boss: PgBoss, options: WorkerDeps): Promise<void> {
  const { db, storage, log } = options;
  const workOptions = { pollingIntervalSeconds: options.pollingIntervalSeconds ?? 2 };
  const deps: PhotoAiDeps = {
    db,
    storage,
    gemini: options.ai?.gemini ?? null,
    embedder: options.ai?.embedder ?? null,
    dailyCapMicros: options.ai?.dailyCapMicros ?? 0,
  };
  const retryDelay = options.aiRetryDelaySeconds;
  let capReportedFor = '';

  await boss.createQueue(QUEUES.photoSpotFailed);
  await boss.work<{ mediaId: string }>(QUEUES.photoSpotFailed, workOptions, async (jobs) => {
    for (const { data } of jobs) {
      await db
        .update(media)
        .set({ spotStatus: 'failed', spottedAt: new Date() })
        .where(and(eq(media.id, data.mediaId), isNull(media.spotStatus)));
      log.error({ mediaId: data.mediaId }, 'photo reading failed after retries');
    }
  });
  await boss.createQueue(QUEUES.photoSpot, {
    // One queued and one running per photo: a job paused by the spend cap can queue its own rerun.
    policy: 'stately',
    retryLimit: 3,
    retryDelay: retryDelay ?? 30,
    retryBackoff: true,
    expireInSeconds: 180,
    deadLetter: QUEUES.photoSpotFailed,
  });
  await boss.work<{ mediaId: string }>(QUEUES.photoSpot, workOptions, async (jobs) => {
    for (const { data } of jobs) {
      try {
        const result = await spotPhoto(deps, data.mediaId);
        log.info({ mediaId: data.mediaId, ...result }, 'photo read');
        if (deps.embedder && result.outcome !== 'failed') {
          await boss.send(QUEUES.photoFingerprint, data, { singletonKey: data.mediaId });
        }
      } catch (error) {
        if (error instanceof SpendCapReachedError) {
          const today = new Date().toISOString().slice(0, 10);
          if (capReportedFor !== today) {
            capReportedFor = today;
            log.error(
              { spentMicros: error.spentMicros, capMicros: error.capMicros },
              'daily AI spend cap reached: photo reading paused until 00:00 UTC',
            );
          }
          await boss.send(QUEUES.photoSpot, data, {
            singletonKey: data.mediaId,
            startAfter: nextUtcDay(),
          });
          continue;
        }
        log.error({ err: error, mediaId: data.mediaId }, 'photo reading failed');
        throw error;
      }
    }
  });

  await boss.createQueue(QUEUES.photoFingerprint, {
    policy: 'stately',
    retryLimit: 4,
    retryDelay: retryDelay ?? 20,
    retryBackoff: true,
    // Up to 45 s per 20 boxes, plus a machine waking after a deploy.
    expireInSeconds: 300,
  });
  await boss.work<{ mediaId: string }>(QUEUES.photoFingerprint, workOptions, async (jobs) => {
    for (const { data } of jobs) {
      try {
        const result = await fingerprintPhoto(deps, data.mediaId);
        log.info({ mediaId: data.mediaId, ...result }, 'photo fingerprinted');
      } catch (error) {
        log.error({ err: error, mediaId: data.mediaId }, 'fingerprinting failed');
        // A refused photo or bad answer won't change by retrying.
        if (error instanceof EmbedderError && !error.retryable) continue;
        throw error;
      }
    }
  });
}
