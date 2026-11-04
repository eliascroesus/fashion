import { type Db, ensureEventPartitions, idempotencyKeys, lt, sql } from '@outfitly/db';
import type { FastifyBaseLogger } from 'fastify';
import { PgBoss } from 'pg-boss';
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
      } catch (error) {
        log.error({ err: error, mediaId: data.mediaId }, 'photo failed');
        // A photo we can't use won't get better with retries; anything else is retried.
        if (!(error instanceof ImageRejectedError)) throw error;
        await markMediaFailed(db, data.mediaId, error.message);
      }
    }
  });
}
