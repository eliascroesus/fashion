import { sql } from '@outfitly/db';
import type { LookDetail } from '@outfitly/shared';
import { ApiError } from './errors.ts';
import { itemRows, toLookItems } from './look-items.ts';
import { type FeedDeps, photoColumns, type PhotoRow, showableLook, toPhoto } from './feed/cards.ts';

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

interface LookPhotoRow extends PhotoRow {
  id: string;
}

/**
 * One look as the look page shows it, for `viewerProfileId` (null when logged
 * out): all its ready photos in order, who posted it, whether the viewer
 * saved it and follows them, and its pieces. Throws 404 unless the look can
 * be shown. Four queries whatever the number of photos and pieces.
 */
export async function lookDetail(
  { db, storage }: FeedDeps,
  viewerProfileId: string | null,
  lookId: string,
): Promise<LookDetail> {
  const viewer = sql`${viewerProfileId}::uuid`;
  const [look, photos, avatar, pieceRows] = await Promise.all([
    db.execute<LookRow>(sql`
      SELECT l.id, l.slug, l.caption, l.published_at, a.id AS author_id, a.handle,
             a.display_name, a.is_verified,
             EXISTS (SELECT 1 FROM saves s WHERE s.profile_id = ${viewer} AND s.look_id = l.id
                        AND s.deleted_at IS NULL) AS saved,
             EXISTS (SELECT 1 FROM follows f WHERE f.follower_profile_id = ${viewer}
                        AND f.followed_profile_id = a.id AND f.deleted_at IS NULL) AS following
        FROM looks l JOIN profiles a ON a.id = l.author_profile_id
       WHERE l.id = ${lookId} AND ${showableLook(sql`l`)} AND l.published_at <= now()`),
    db.execute<LookPhotoRow>(sql`
      SELECT m.id, m.width, m.height, m.thumbhash, m.dominant_color,
             m.key_1080, m.key_600, m.key_300
        FROM look_media lm JOIN media m ON m.id = lm.media_id
       WHERE lm.look_id = ${lookId} AND m.status = 'ready' AND m.deleted_at IS NULL
       ORDER BY lm.position`),
    db.execute<PhotoRow>(sql`
      SELECT m.width, m.height, m.thumbhash, m.dominant_color, m.key_1080, m.key_600, m.key_300
        FROM looks l JOIN profiles a ON a.id = l.author_profile_id
        JOIN media m ON m.id = a.avatar_media_id
       WHERE l.id = ${lookId} AND m.status = 'ready' AND m.deleted_at IS NULL`),
    itemRows(db, lookId),
  ]);
  const row = look.rows[0];
  if (!row) throw notFound();
  const avatarRow = avatar.rows[0];
  const shown = photos.rows.flatMap((p) => {
    const photo = toPhoto(storage, photoColumns(p));
    return photo ? [{ id: p.id, photo }] : [];
  });
  const items = toLookItems(
    storage,
    pieceRows,
    shown.map((p) => p.id),
  );
  return {
    id: row.id,
    slug: row.slug,
    caption: row.caption,
    publishedAt: new Date(row.published_at).toISOString(),
    photos: shown.map((p) => p.photo),
    author: {
      id: row.author_id,
      handle: row.handle,
      displayName: row.display_name,
      avatar: avatarRow ? toPhoto(storage, photoColumns(avatarRow)) : null,
      isVerified: row.is_verified,
      isFollowing: row.following,
    },
    saved: row.saved,
    itemCount: items.length,
    items,
  };
}
