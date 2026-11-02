import { type Db, idempotencyKeys, lt, sql } from '@outfitly/db';
import type { FastifyBaseLogger } from 'fastify';
import { PgBoss } from 'pg-boss';

export const QUEUES = {
  /** Does nothing but log; proves the job system works end to end. */
  ping: 'system-ping',
  idempotencyCleanup: 'idempotency-cleanup',
} as const;

export interface JobsOptions {
  /** Supabase direct or session connection: pg-boss breaks behind the transaction pooler. */
  databaseUrl: string;
  caCert?: string | undefined;
  db: Db;
  log: FastifyBaseLogger;
  pollingIntervalSeconds?: number;
}

/** Starts pg-boss (job queue inside Postgres, schema `pgboss`) and its workers. */
export async function startJobs(options: JobsOptions): Promise<PgBoss> {
  const { db, log } = options;
  const boss = new PgBoss({
    connectionString: options.databaseUrl,
    ssl: options.caCert ? { ca: options.caCert } : undefined,
    schema: 'pgboss',
    application_name: 'outfitly-api-jobs',
    max: 3,
  });
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

  return boss;
}
