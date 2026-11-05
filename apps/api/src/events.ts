import { type Db, seen, sql } from '@outfitly/db';
import { type ClientEvent, clientEventSchema, type EventBatch } from '@outfitly/shared';
import { FEED_RULES } from './feed/arrange.ts';

/**
 * Events are stored with the time they happened on the phone, so a batch
 * sent again lands on the same (created_at, id) key and is skipped. Times
 * outside this window (a stale offline queue, a phone clock far off) are dropped.
 */
export const EVENT_TIME_WINDOW = { pastDays: 7, futureMinutes: 10 } as const;

/**
 * Stores a batch from the app: only published looks, each event id once.
 * A logged-in profile's impressions also go into `seen`, so For You leaves
 * those looks out for a week. Returns how many events were new.
 */
/** The events of a batch the server can read; the others are skipped one by one. */
export function readableEvents(events: readonly unknown[]): ClientEvent[] {
  return events.flatMap((e) => {
    const parsed = clientEventSchema.safeParse(e);
    return parsed.success ? [parsed.data] : [];
  });
}

export async function recordEvents(
  db: Db,
  profileId: string | null,
  batch: EventBatch,
): Promise<number> {
  const incoming = JSON.stringify(
    batch.events.map((e) => ({
      id: e.id,
      name: e.name,
      look_id: e.lookId,
      position: e.position,
      source: e.source,
      occurred_at: e.occurredAt,
    })),
  );
  const { pastDays, futureMinutes } = EVENT_TIME_WINDOW;
  // Data-modifying CTEs all run, even when the final SELECT doesn't read them.
  const seenUpsert = profileId
    ? sql`, marked AS (
        INSERT INTO seen (profile_id, look_id, last_seen_at)
        SELECT ${profileId}::uuid, look_id, max(occurred_at) FROM valid
         WHERE name = 'impression' GROUP BY look_id
         -- Same row order for every batch, so two phones of one profile can't deadlock.
         ORDER BY look_id
        ON CONFLICT (profile_id, look_id) DO UPDATE
          SET last_seen_at = GREATEST(seen.last_seen_at, EXCLUDED.last_seen_at), updated_at = now())`
    : sql``;
  const { rows } = await db.execute<{ accepted: number }>(sql`
    WITH incoming AS (
      SELECT * FROM jsonb_to_recordset(${incoming}::jsonb)
        AS e(id uuid, name text, look_id uuid, position int, source text, occurred_at timestamptz)
    ), valid AS (
      SELECT * FROM incoming e
       WHERE e.occurred_at > now() - make_interval(days => ${pastDays})
         AND e.occurred_at < now() + make_interval(mins => ${futureMinutes})
         AND EXISTS (SELECT 1 FROM looks l
                      WHERE l.id = e.look_id AND l.status = 'published' AND l.deleted_at IS NULL)
    ), inserted AS (
      INSERT INTO events (id, created_at, name, profile_id, session_id, look_id, position, source, platform)
      SELECT id, occurred_at, name, ${profileId}::uuid, ${batch.sessionId}::uuid, look_id, position,
             source, ${batch.platform}::client_platform
        FROM valid
      ON CONFLICT (created_at, id) DO NOTHING
      RETURNING 1
    )${seenUpsert}
    SELECT count(*)::int AS accepted FROM inserted`);
  return rows[0]?.accepted ?? 0;
}

/** Deletes `seen` rows older than the feed looks back. Returns how many. */
export async function deleteOldSeen(db: Db): Promise<number> {
  const result = await db
    .delete(seen)
    .where(sql`${seen.lastSeenAt} < now() - make_interval(days => ${FEED_RULES.seenDays})`);
  return result.rowCount ?? 0;
}
