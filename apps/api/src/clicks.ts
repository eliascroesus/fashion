import { type Db, sql } from '@outfitly/db';
import type { ClickBatch } from '@outfitly/shared';

/**
 * Stores a batch of Shop taps from the app, each click id once. A click
 * counts when its shop link is (or was) a piece of that look: the app only
 * shows verified pieces of visible looks, but a click that waited on the
 * phone is kept even if the piece or the look has gone since (clicks are
 * history, like events). The poster is taken from the look, never from the
 * app. Returns how many clicks were new.
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
    })),
  );
  const { rows } = await db.execute<{ accepted: number }>(sql`
    WITH incoming AS (
      SELECT * FROM jsonb_to_recordset(${incoming}::jsonb)
        AS c(id uuid, look_id uuid, offer_id uuid, source text, position int)
    ), inserted AS (
      INSERT INTO clicks (id, profile_id, session_id, look_id, offer_id, author_profile_id,
                          position, source, platform)
      SELECT c.id, ${profileId}::uuid, ${batch.sessionId}::uuid, c.look_id, c.offer_id,
             l.author_profile_id, c.position, c.source, ${batch.platform}::client_platform
        FROM incoming c
        JOIN looks l ON l.id = c.look_id
       WHERE EXISTS (SELECT 1 FROM look_items li
                      WHERE li.look_id = c.look_id AND li.offer_id = c.offer_id)
      -- A click sent again (a retry, or twice in one batch) is stored once.
      ON CONFLICT (id) DO NOTHING
      RETURNING 1
    )
    SELECT count(*)::int AS accepted FROM inserted`);
  return rows[0]?.accepted ?? 0;
}
