import { type Db, sql } from '@outfitly/db';
import { type ClickBatch, type ClientClick, clientClickSchema } from '@outfitly/shared';
import { EVENT_TIME_WINDOW } from './events.ts';

/** The clicks of a batch the server can read; the others are skipped, never the whole batch. */
export function readableClicks(clicks: readonly unknown[]): ClientClick[] {
  return clicks.flatMap((c) => {
    const parsed = clientClickSchema.safeParse(c);
    return parsed.success ? [parsed.data] : [];
  });
}

/**
 * Stores a batch of Shop taps from the app, each click id once (a click sent
 * again keeps its first row). A click counts when its shop link is a piece of
 * that look that was shown at some point: verified now, or verified by an
 * earlier link check, on a look that was published. So a click that waited
 * on the phone still counts after the piece or the look has gone (clicks are
 * history, like events), but a piece nobody could see can't collect clicks.
 * The poster is taken from the look, never from the app. The click is dated
 * by the tap (the phone's clock), kept within the events' time window and
 * never in the future. Returns how many clicks were new.
 */
export async function recordClicks(
  db: Db,
  profileId: string | null,
  batch: ClickBatch,
): Promise<number> {
  const incoming = JSON.stringify(
    batch.clicks.map((c) => ({
      id: c.id,
      look_id: c.lookId,
      offer_id: c.offerId,
      source: c.source,
      position: c.position,
      tapped_at: c.tappedAt,
    })),
  );
  const { pastDays } = EVENT_TIME_WINDOW;
  const { rows } = await db.execute<{ accepted: number }>(sql`
    WITH incoming AS (
      SELECT * FROM jsonb_to_recordset(${incoming}::jsonb)
        AS c(id uuid, look_id uuid, offer_id uuid, source text, position int, tapped_at timestamptz)
    ), inserted AS (
      INSERT INTO clicks (id, created_at, profile_id, session_id, look_id, offer_id,
                          author_profile_id, position, source, platform)
      SELECT c.id,
             LEAST(GREATEST(c.tapped_at, now() - make_interval(days => ${pastDays})), now()),
             ${profileId}::uuid, ${batch.sessionId}::uuid, c.look_id, c.offer_id,
             l.author_profile_id, c.position, c.source, ${batch.platform}::client_platform
        FROM incoming c
        JOIN looks l ON l.id = c.look_id AND l.published_at IS NOT NULL
       WHERE EXISTS (
               SELECT 1 FROM look_items li
                WHERE li.look_id = c.look_id AND li.offer_id = c.offer_id
                  AND (li.status = 'verified'
                       OR EXISTS (SELECT 1 FROM link_checks lc
                                   WHERE lc.look_item_id = li.id AND lc.outcome = 'verified')))
      -- A click sent again (a retry, or twice in one batch) is stored once.
      ON CONFLICT (id) DO NOTHING
      RETURNING 1
    )
    SELECT count(*)::int AS accepted FROM inserted`);
  return rows[0]?.accepted ?? 0;
}
