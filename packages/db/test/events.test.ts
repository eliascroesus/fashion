import { sql } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { type Db } from '../src/client.ts';
import { ensureEventPartitions, eventPartitionName } from '../src/events.ts';
import { events } from '../src/schema/index.ts';
import { createMigratedTestDatabase, type TestDatabase, withDb } from './test-database.ts';

let testDb: TestDatabase;

beforeAll(async () => {
  testDb = await createMigratedTestDatabase();
});

afterAll(async () => {
  await testDb.drop();
});

/** Which partition a row with this time is stored in. */
async function partitionOf(db: Db, createdAt: Date): Promise<string | undefined> {
  const [row] = await db
    .insert(events)
    .values({ name: 'impression', createdAt, position: 3 })
    .returning({ id: events.id });
  const { rows } = await db.execute<{ partition: string }>(
    sql`SELECT tableoid::regclass::text AS partition FROM events WHERE id = ${row?.id}`,
  );
  return rows[0]?.partition;
}

describe('events split by month', () => {
  it('names partitions by UTC month', () => {
    expect(eventPartitionName(new Date('2026-11-01T00:00:00Z'))).toBe('events_y2026m11');
    expect(eventPartitionName(new Date('2027-01-01T00:00:00Z'))).toBe('events_y2027m01');
  });

  it('creates this month and the next two, once', async () => {
    await withDb(testDb.url, async (db) => {
      const now = new Date('2026-12-15T12:00:00Z');
      expect(await ensureEventPartitions(db, now)).toEqual([
        'events_y2026m12',
        'events_y2027m01',
        'events_y2027m02',
      ]);
      expect(await ensureEventPartitions(db, now)).toEqual([]);
    });
  });

  it('stores each event in its month, using UTC month edges', async () => {
    await withDb(testDb.url, async (db) => {
      expect(await partitionOf(db, new Date('2026-12-31T23:59:59.999Z'))).toBe('events_y2026m12');
      expect(await partitionOf(db, new Date('2027-01-01T00:00:00Z'))).toBe('events_y2027m01');
    });
  });

  it('never refuses an event: months without a partition go to the default one, then move', async () => {
    await withDb(testDb.url, async (db) => {
      const later = new Date('2027-06-10T08:00:00Z');
      expect(await partitionOf(db, later)).toBe('events_default');

      expect(await ensureEventPartitions(db, later, 0)).toEqual(['events_y2027m06']);
      const { rows } = await db.execute<{ partition: string; n: number }>(
        sql`SELECT tableoid::regclass::text AS partition, count(*)::int AS n
              FROM events WHERE created_at >= '2027-06-01' AND created_at < '2027-07-01'
             GROUP BY 1`,
      );
      expect(rows).toEqual([{ partition: 'events_y2027m06', n: 1 }]);
    });
  });

  it('locks new partitions like every other table: RLS on, nothing granted to Supabase API roles', async () => {
    await withDb(testDb.url, async (db) => {
      const { rows } = await db.execute<{ relname: string; rls: boolean; granted: boolean }>(sql`
        SELECT c.relname, c.relrowsecurity AS rls,
               bool_or(has_table_privilege(r, c.oid, 'SELECT')) AS granted
          FROM pg_inherits i
          JOIN pg_class c ON c.oid = i.inhrelid
          CROSS JOIN unnest(ARRAY['anon', 'authenticated', 'service_role']) AS r
         WHERE i.inhparent = 'public.events'::regclass
         GROUP BY c.relname, c.relrowsecurity`);
      expect(rows.length).toBeGreaterThanOrEqual(5);
      for (const row of rows) expect(row, row.relname).toMatchObject({ rls: true, granted: false });
    });
  });

  it('two machines starting at once both succeed', async () => {
    await withDb(testDb.url, async (db) => {
      const now = new Date('2028-03-01T00:00:00Z');
      const results = await Promise.all([
        ensureEventPartitions(db, now, 1),
        ensureEventPartitions(db, now, 1),
      ]);
      expect(results.flat().sort()).toEqual(['events_y2028m03', 'events_y2028m04']);
    });
  });
});
