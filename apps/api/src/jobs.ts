import { type Db, idempotencyKeys, lt, sql } from '@outfitly/db';
import type { FastifyBaseLogger } from 'fastify';
import { PgBoss } from 'pg-boss';
import { UnreadableImageError } from './media/image.ts';
import { markMediaFailed, processUploadedMedia } from './media/pipeline.ts';
import type { PhotoStorage } from './storage.ts';

export const QUEUES = {
  /** Does nothing but log; proves the job system works end to end. */
  ping: 'system-ping',
  idempotencyCleanup: 'idempotency-cleanup',
  /** Makes the public sizes of one uploaded photo. */
  mediaProcess: 'media-process',
} as const;

const MEDIA_RETRY_LIMIT = 2;

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

  await boss.createQueue(QUEUES.mediaProcess, { retryLimit: MEDIA_RETRY_LIMIT, retryDelay: 10 });
  await boss.work<{ mediaId: string }>(QUEUES.mediaProcess, workOptions, async (jobs) => {
    for (const { data, retryCount } of jobs) {
      try {
        await processUploadedMedia(db, storage, data.mediaId);
        log.info({ mediaId: data.mediaId }, 'photo processed');
      } catch (error) {
        // A photo we can't read won't get better with retries.
        const lastTry = error instanceof UnreadableImageError || retryCount >= MEDIA_RETRY_LIMIT;
        log.error({ err: error, mediaId: data.mediaId, retryCount, lastTry }, 'photo failed');
        if (!lastTry) throw error;
        await markMediaFailed(db, data.mediaId, String(error));
      }
    }
  });
}
