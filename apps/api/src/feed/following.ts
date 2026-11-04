import { sql } from '@outfitly/db';
import { FEED_PAGE_SIZE, type FeedPage } from '@outfitly/shared';
import { z } from 'zod';
import {
  decodeCursor,
  encodeCursor,
  type FeedDeps,
  loadCards,
  microsTime,
  showableLook,
} from './cards.ts';

/** The last look of the previous page. `t` keeps Postgres's microseconds (a JS Date can't). */
const cursorSchema = z.object({ t: microsTime, id: z.uuid() });

/**
 * One page of the Following feed: everything the people this profile follows
 * have published, newest first (no reshuffling, no "seen" filter).
 */
export async function followingPage(
  deps: FeedDeps,
  profileId: string,
  cursor: string | undefined,
): Promise<FeedPage> {
  const after = cursor === undefined ? undefined : decodeCursor(cursorSchema, cursor);
  const { rows } = await deps.db.execute<{ id: string; published_at: string }>(sql`
    SELECT l.id,
           to_char(l.published_at AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.US"Z"') AS published_at
      FROM looks l
     WHERE ${showableLook(sql`l`)}
       AND l.published_at <= now()
       AND l.author_profile_id IN (SELECT f.followed_profile_id FROM follows f
                                    WHERE f.follower_profile_id = ${profileId} AND f.deleted_at IS NULL)
       ${after ? sql`AND (l.published_at, l.id) < (${after.t}::timestamptz, ${after.id}::uuid)` : sql``}
     ORDER BY l.published_at DESC, l.id DESC
     LIMIT ${FEED_PAGE_SIZE + 1}`);

  const page = rows.slice(0, FEED_PAGE_SIZE);
  const cards = await loadCards(
    deps,
    page.map((r) => r.id),
    profileId,
  );
  const last = page.at(-1);
  return {
    // A look hidden between the two queries is left out of this page.
    items: page.flatMap((r) => cards.get(r.id) ?? []),
    nextCursor:
      rows.length > FEED_PAGE_SIZE && last
        ? encodeCursor({ t: last.published_at, id: last.id })
        : null,
  };
}
