import { sql } from '@outfitly/db';
import {
  FEED_PAGE_SIZE,
  type FeedPage,
  type LookDetail,
  MAX_SIMILAR_LOOKS,
} from '@outfitly/shared';
import { z } from 'zod';
import { ApiError } from './errors.ts';
import {
  decodeCursor,
  encodeCursor,
  type FeedDeps,
  loadCards,
  microsText,
  microsTime,
  showableLook,
  toPhoto,
} from './feed/cards.ts';

const notFound = () => new ApiError(404, 'not_found', 'Look not found.');

interface LookRow extends Record<string, unknown> {
  id: string;
  slug: string;
  caption: string | null;
  published_at: Date;
  author_id: string;
  handle: string;
  display_name: string | null;
  is_verified: boolean;
  saved: boolean;
  following: boolean;
}

interface PhotoRow extends Record<string, unknown> {
  width: number | null;
  height: number | null;
  thumbhash: string | null;
  dominant_color: string | null;
  key_1080: string | null;
  key_600: string | null;
  key_300: string | null;
}

const photoColumns = (row: PhotoRow) => ({
  width: row.width,
  height: row.height,
  thumbhash: row.thumbhash,
  dominantColor: row.dominant_color,
  key1080: row.key_1080,
  key600: row.key_600,
  key300: row.key_300,
});

/**
 * One look as the look page shows it, for `viewerProfileId` (null when logged
 * out): all its ready photos in order, who posted it, and whether the viewer
 * saved it and follows them. Throws 404 unless the look can be shown.
 */
export async function lookDetail(
  { db, storage }: FeedDeps,
  viewerProfileId: string | null,
  lookId: string,
): Promise<LookDetail> {
  const viewer = sql`${viewerProfileId}::uuid`;
  const [look, photos, avatar] = await Promise.all([
    db.execute<LookRow>(sql`
      SELECT l.id, l.slug, l.caption, l.published_at, a.id AS author_id, a.handle,
             a.display_name, a.is_verified,
             EXISTS (SELECT 1 FROM saves s WHERE s.profile_id = ${viewer} AND s.look_id = l.id
                        AND s.deleted_at IS NULL) AS saved,
             EXISTS (SELECT 1 FROM follows f WHERE f.follower_profile_id = ${viewer}
                        AND f.followed_profile_id = a.id AND f.deleted_at IS NULL) AS following
        FROM looks l JOIN profiles a ON a.id = l.author_profile_id
       WHERE l.id = ${lookId} AND ${showableLook(sql`l`)}`),
    db.execute<PhotoRow>(sql`
      SELECT m.width, m.height, m.thumbhash, m.dominant_color, m.key_1080, m.key_600, m.key_300
        FROM look_media lm JOIN media m ON m.id = lm.media_id
       WHERE lm.look_id = ${lookId} AND m.status = 'ready' AND m.deleted_at IS NULL
       ORDER BY lm.position`),
    db.execute<PhotoRow>(sql`
      SELECT m.width, m.height, m.thumbhash, m.dominant_color, m.key_1080, m.key_600, m.key_300
        FROM looks l JOIN profiles a ON a.id = l.author_profile_id
        JOIN media m ON m.id = a.avatar_media_id
       WHERE l.id = ${lookId} AND m.status = 'ready' AND m.deleted_at IS NULL`),
  ]);
  const row = look.rows[0];
  if (!row) throw notFound();
  const avatarRow = avatar.rows[0];
  return {
    id: row.id,
    slug: row.slug,
    caption: row.caption,
    publishedAt: new Date(row.published_at).toISOString(),
    photos: photos.rows.flatMap((p) => toPhoto(storage, photoColumns(p)) ?? []),
    author: {
      id: row.author_id,
      handle: row.handle,
      displayName: row.display_name,
      avatar: avatarRow ? toPhoto(storage, photoColumns(avatarRow)) : null,
      isVerified: row.is_verified,
      isFollowing: row.following,
    },
    saved: row.saved,
    itemCount: 0, // Shoppable pieces arrive with products (Phase 3).
  };
}

/**
 * Where the next "more like this" page starts: the last look's ranking
 * (shared tags, popularity, publish time, id) and how many were shown.
 */
const similarCursorSchema = z.object({
  s: z.number().int().nonnegative(),
  p: z.number(),
  t: microsTime,
  id: z.uuid(),
  n: z.number().int().positive().max(MAX_SIMILAR_LOOKS),
});

interface SimilarRow extends Record<string, unknown> {
  id: string;
  shared: number;
  popularity_score: number;
  t: string;
}

/**
 * "More like this": other looks ranked by how many occasion and season tags
 * they share with this one, then popularity, then newest (AI similarity
 * replaces the tags in Phase 3). At most MAX_SIMILAR_LOOKS in all. Scores can
 * change between pages, so a look may rarely repeat (the app drops repeats).
 */
export async function similarPage(
  deps: FeedDeps,
  viewerProfileId: string | null,
  lookId: string,
  cursor: string | undefined,
): Promise<FeedPage> {
  const after = cursor === undefined ? undefined : decodeCursor(similarCursorSchema, cursor);
  const shown = after?.n ?? 0;
  const { rows: base } = await deps.db.execute(sql`
    SELECT 1 FROM looks l WHERE l.id = ${lookId} AND ${showableLook(sql`l`)}`);
  if (base.length === 0) throw notFound();
  const left = MAX_SIMILAR_LOOKS - shown;
  if (left <= 0) return { items: [], nextCursor: null };
  const take = Math.min(FEED_PAGE_SIZE, left);

  const { rows } = await deps.db.execute<SimilarRow>(sql`
    WITH base AS (SELECT b.occasion_tags::text[] || b.season_tags::text[] AS tags
                    FROM looks b WHERE b.id = ${lookId})
    SELECT c.id, c.shared, c.popularity_score, ${microsText(sql`c.published_at`)} AS t
      FROM (SELECT l.id, l.popularity_score, l.published_at,
                   cardinality(ARRAY(SELECT unnest(l.occasion_tags::text[] || l.season_tags::text[])
                                     INTERSECT SELECT unnest(base.tags)))::int AS shared
              FROM looks l, base
             WHERE ${showableLook(sql`l`)} AND l.published_at <= now() AND l.id <> ${lookId}) c
     ${
       after
         ? sql`WHERE (c.shared, c.popularity_score, c.published_at, c.id)
                   < (${after.s}::int, ${after.p}::float8, ${after.t}::timestamptz, ${after.id}::uuid)`
         : sql``
     }
     ORDER BY c.shared DESC, c.popularity_score DESC, c.published_at DESC, c.id DESC
     LIMIT ${take + 1}`);

  const page = rows.slice(0, take);
  const cards = await loadCards(
    deps,
    page.map((r) => r.id),
    viewerProfileId,
  );
  const last = page.at(-1);
  const more = rows.length > take && shown + page.length < MAX_SIMILAR_LOOKS;
  return {
    // A look hidden between the two queries is left out of this page.
    items: page.flatMap((r) => cards.get(r.id) ?? []),
    nextCursor:
      more && last
        ? encodeCursor({
            s: last.shared,
            p: last.popularity_score,
            t: last.t,
            id: last.id,
            n: shown + page.length,
          })
        : null,
  };
}
