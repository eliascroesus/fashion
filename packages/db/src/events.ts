import { sql } from 'drizzle-orm';
import type { Db } from './client.ts';

/** `events_y2026m11` for November 2026 (UTC). */
export function eventPartitionName(monthStart: Date): string {
  const month = String(monthStart.getUTCMonth() + 1).padStart(2, '0');
  return `events_y${String(monthStart.getUTCFullYear())}m${month}`;
}

/**
 * Makes sure `events` has a partition for this month and the next
 * `monthsAhead` months (UTC). Safe to run any time, from several machines at
 * once. Events that landed in `events_default` for a month (only if this
 * didn't run for months) move into that month's new partition.
 * Returns the partitions it created.
 */
export async function ensureEventPartitions(
  db: Db,
  now: Date = new Date(),
  monthsAhead = 2,
): Promise<string[]> {
  return db.transaction(async (tx) => {
    await tx.execute(sql`SELECT pg_advisory_xact_lock(hashtext('ensure_event_partitions'))`);
    const created: string[] = [];
    for (let i = 0; i <= monthsAhead; i++) {
      const start = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth() + i, 1));
      const end = new Date(Date.UTC(start.getUTCFullYear(), start.getUTCMonth() + 1, 1));
      const name = eventPartitionName(start);
      const { rows } = await tx.execute<{ exists: boolean }>(
        sql`SELECT to_regclass(${`public.${name}`}) IS NOT NULL AS exists`,
      );
      if (rows[0]?.exists) continue;

      const table = sql`public.${sql.identifier(name)}`;
      // Bounds are built from Dates above; DDL can't take query parameters.
      const bounds = sql.raw(`FROM ('${start.toISOString()}') TO ('${end.toISOString()}')`);
      // Built standalone and attached (rather than CREATE … PARTITION OF) so rows
      // from the default partition can move first and inserts aren't blocked.
      await tx.execute(
        sql`CREATE TABLE ${table} (LIKE public.events INCLUDING DEFAULTS INCLUDING CONSTRAINTS)`,
      );
      await tx.execute(sql`ALTER TABLE ${table} ENABLE ROW LEVEL SECURITY`);
      await tx.execute(sql`
        WITH moved AS (
          DELETE FROM public.events_default
           WHERE created_at >= ${start.toISOString()} AND created_at < ${end.toISOString()}
          RETURNING *)
        INSERT INTO ${table} SELECT * FROM moved`);
      await tx.execute(
        sql`ALTER TABLE public.events ATTACH PARTITION ${table} FOR VALUES ${bounds}`,
      );
      created.push(name);
    }
    return created;
  });
}
