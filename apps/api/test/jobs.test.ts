import { eventPartitionName, idempotencyKeys, sql } from '@outfitly/db';
import type { PgBoss } from 'pg-boss';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createJobQueue, QUEUES, startJobs } from '../src/jobs.ts';
import { createTestContext, type TestContext } from './helpers.ts';

let ctx: TestContext;
let boss: PgBoss;
const logged: unknown[] = [];
const log = {
  info: (obj: unknown) => logged.push(obj),
  error: (obj: unknown) => logged.push(obj),
} as unknown as Parameters<typeof startJobs>[1]['log'];

beforeAll(async () => {
  ctx = await createTestContext();
  boss = createJobQueue(ctx.testDb.url);
  await startJobs(boss, { db: ctx.db, storage: ctx.storage, log, pollingIntervalSeconds: 0.5 });
});

afterAll(async () => {
  await boss.stop({ graceful: false, close: true });
  await ctx.close();
});

async function waitForState(queue: string, id: string, state: string): Promise<void> {
  await expect
    .poll(async () => (await boss.findJobs(queue, { id }))[0]?.state, { timeout: 15_000 })
    .toBe(state);
}

describe('background jobs (pg-boss)', () => {
  it('run the test job', async () => {
    const id = await boss.send(QUEUES.ping, { reason: 'test' });
    if (!id) throw new Error('job was not created');
    await waitForState(QUEUES.ping, id, 'completed');
    expect(logged).toContainEqual(expect.objectContaining({ jobId: id }));
  });

  it('remove expired idempotency keys and keep fresh ones', async () => {
    const user = crypto.randomUUID();
    await ctx.db.insert(idempotencyKeys).values([
      {
        userId: user,
        key: 'expired-key-1',
        requestHash: 'h',
        expiresAt: new Date(Date.now() - 1000),
      },
      { userId: user, key: 'fresh-key-123', requestHash: 'h' },
    ]);
    const id = await boss.send(QUEUES.idempotencyCleanup, {});
    if (!id) throw new Error('job was not created');
    await waitForState(QUEUES.idempotencyCleanup, id, 'completed');
    const left = await ctx.db.select({ key: idempotencyKeys.key }).from(idempotencyKeys);
    expect(left).toEqual([{ key: 'fresh-key-123' }]);
  });

  it('schedule the daily cleanup', async () => {
    const schedules = await boss.getSchedules();
    expect(schedules).toContainEqual(
      expect.objectContaining({ name: QUEUES.idempotencyCleanup, cron: '17 3 * * *' }),
    );
  });

  it('make the events partitions for this month and the next two, every day', async () => {
    const id = await boss.send(QUEUES.eventPartitions, {});
    if (!id) throw new Error('job was not created');
    await waitForState(QUEUES.eventPartitions, id, 'completed');
    const now = new Date();
    const expected = [0, 1, 2].map((i) =>
      eventPartitionName(new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth() + i, 1))),
    );
    const { rows } = await ctx.db.execute<{ name: string }>(
      sql`SELECT inhrelid::regclass::text AS name FROM pg_inherits
           WHERE inhparent = 'public.events'::regclass ORDER BY 1`,
    );
    expect(rows.map((r) => r.name)).toEqual(['events_default', ...expected].sort());

    const schedules = await boss.getSchedules();
    expect(schedules).toContainEqual(
      expect.objectContaining({ name: QUEUES.eventPartitions, cron: '7 2 * * *' }),
    );
  });

  it('recompute popularity every 15 minutes and clear old feed lists hourly', async () => {
    const id = await boss.send(QUEUES.feedPopularity, {});
    if (!id) throw new Error('job was not created');
    await waitForState(QUEUES.feedPopularity, id, 'completed');
    const cleanup = await boss.send(QUEUES.feedSnapshotCleanup, {});
    if (!cleanup) throw new Error('job was not created');
    await waitForState(QUEUES.feedSnapshotCleanup, cleanup, 'completed');

    const schedules = await boss.getSchedules();
    expect(schedules).toContainEqual(
      expect.objectContaining({ name: QUEUES.feedPopularity, cron: '*/15 * * * *' }),
    );
    expect(schedules).toContainEqual(
      expect.objectContaining({ name: QUEUES.feedSnapshotCleanup, cron: '37 * * * *' }),
    );
  });

  it('clear old "seen" rows every day', async () => {
    const id = await boss.send(QUEUES.seenCleanup, {});
    if (!id) throw new Error('job was not created');
    await waitForState(QUEUES.seenCleanup, id, 'completed');
    const schedules = await boss.getSchedules();
    expect(schedules).toContainEqual(
      expect.objectContaining({ name: QUEUES.seenCleanup, cron: '47 3 * * *' }),
    );
  });

  it('rebuild the search words every 15 minutes', async () => {
    const id = await boss.send(QUEUES.searchTerms, {});
    if (!id) throw new Error('job was not created');
    await waitForState(QUEUES.searchTerms, id, 'completed');
    const schedules = await boss.getSchedules();
    expect(schedules).toContainEqual(
      expect.objectContaining({ name: QUEUES.searchTerms, cron: '*/15 * * * *' }),
    );
  });

  it('check prices and stock every 10 minutes, one run at a time', async () => {
    const id = await boss.send(QUEUES.priceRefresh, {});
    if (!id) throw new Error('job was not created');
    await waitForState(QUEUES.priceRefresh, id, 'completed');
    // An empty catalogue: the run is logged and reads nothing.
    const { rows } = await ctx.db.execute<{ reads: number }>(
      sql`SELECT (reads_saved_or_popular + reads_others)::int AS reads FROM price_refresh_runs`,
    );
    expect(rows).toEqual([{ reads: 0 }]);
    const schedules = await boss.getSchedules();
    expect(schedules).toContainEqual(
      expect.objectContaining({ name: QUEUES.priceRefresh, cron: '*/10 * * * *' }),
    );
    expect((await boss.getQueue(QUEUES.priceRefresh))?.policy).toBe('exclusive');
  });

  it('keep their tables away from the public app key', async () => {
    const { rows } = await ctx.db.execute(
      sql`SELECT r AS role, has_schema_privilege(r, 'pgboss', 'USAGE') AS usage
            FROM unnest(ARRAY['anon', 'authenticated']) AS r`,
    );
    expect(rows).toEqual([
      { role: 'anon', usage: false },
      { role: 'authenticated', usage: false },
    ]);
  });
});
