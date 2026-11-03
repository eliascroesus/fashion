import { type Db, feedSnapshots, lt, sql } from '@outfitly/db';

export const POPULARITY = {
  /** Only saves and impressions from this many days count. */
  windowDays: 30,
  /** A save or impression counts half as much after this many days. */
  halfLifeDays: 7,
  /**
   * Every look starts as if it had this many saves per this many views (5%),
   * so a look with few views is neither top nor bottom until people react.
   */
  priorSaves: 1,
  priorViews: 20,
} as const;

/**
 * Recomputes `looks.popularity_score` = saves per view, with recent activity
 * weighing more: (decayed saves + 1) / (decayed impressions + 20). Only rows
 * whose rounded score changed are written, and `updated_at` is left alone:
 * the score is derived, `updated_at` tracks edits. Returns rows changed.
 */
export async function recomputePopularity(db: Db): Promise<number> {
  const { windowDays, halfLifeDays, priorSaves, priorViews } = POPULARITY;
  const halfLifeSeconds = halfLifeDays * 24 * 60 * 60;
  const weight = (column: string) =>
    sql`power(0.5, extract(epoch FROM now() - ${sql.identifier(column)})::float8 / ${halfLifeSeconds}::float8)`;
  const result = await db.execute(sql`
    WITH saved AS (
      SELECT look_id, sum(${weight('created_at')}) AS w
        FROM saves
       WHERE deleted_at IS NULL AND created_at > now() - make_interval(days => ${windowDays})
       GROUP BY look_id
    ), viewed AS (
      SELECT look_id, sum(${weight('created_at')}) AS w
        FROM events
       WHERE name = 'impression' AND look_id IS NOT NULL
         AND created_at > now() - make_interval(days => ${windowDays})
       GROUP BY look_id
    ), scored AS (
      SELECT l.id,
             round(((coalesce(s.w, 0) + ${priorSaves}::float8)
                    / (coalesce(v.w, 0) + ${priorViews}::float8))::numeric, 4)::float8 AS score
        FROM looks l
        LEFT JOIN saved s ON s.look_id = l.id
        LEFT JOIN viewed v ON v.look_id = l.id
       WHERE l.status = 'published' AND l.deleted_at IS NULL
    )
    UPDATE looks SET popularity_score = scored.score
      FROM scored
     WHERE looks.id = scored.id AND looks.popularity_score <> scored.score`);
  return result.rowCount ?? 0;
}

/** Deletes For You lists older than a day. Returns how many. */
export async function deleteOldFeedSnapshots(db: Db): Promise<number> {
  const result = await db
    .delete(feedSnapshots)
    .where(lt(feedSnapshots.createdAt, sql`now() - interval '1 day'`));
  return result.rowCount ?? 0;
}
