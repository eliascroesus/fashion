import { type SQL, sql } from '@outfitly/db';
import type { FeedPage, ProfileBrief, ProfilePage } from '@outfitly/shared';
import { ApiError } from './errors.ts';
import { type FeedDeps, photoColumns, type PhotoRow, showableLook, toPhoto } from './feed/cards.ts';
import { newestPage } from './feed/following.ts';
import type { PhotoStorage } from './storage.ts';

const notFound = () => new ApiError(404, 'not_found', 'Profile not found.');

/** A profile and its photo, as `briefColumns` + `avatarJoin` select them (`p` is the profile). */
export interface BriefRow extends PhotoRow {
  id: string;
  handle: string;
  display_name: string | null;
  is_verified: boolean;
}

export const briefColumns = sql`p.id, p.handle, p.display_name, p.is_verified, m.width, m.height,
  m.thumbhash, m.dominant_color, m.key_1080, m.key_600, m.key_300`;

/** The profile's photo, when it has a ready one. */
export const avatarJoin = sql`LEFT JOIN media m ON m.id = p.avatar_media_id
  AND m.status = 'ready' AND m.deleted_at IS NULL`;

export function toBrief(storage: PhotoStorage, row: BriefRow): ProfileBrief {
  return {
    id: row.id,
    handle: row.handle,
    displayName: row.display_name,
    avatar: toPhoto(storage, photoColumns(row)),
    isVerified: row.is_verified,
  };
}

/** Looks on a profile and in its count: the ones feeds may show. */
export const profileLook = (profile: SQL) =>
  sql`l.author_profile_id = ${profile} AND ${showableLook(sql`l`)} AND l.published_at <= now()`;

interface PageRow extends BriefRow {
  looks: number;
  followers: number;
  following: number;
  is_following: boolean;
}

/**
 * The top of a profile screen, for `viewerProfileId` (null when logged out).
 * Followers and following leave out deleted profiles. 404 for a deleted profile.
 */
export async function profilePage(
  { db, storage }: FeedDeps,
  viewerProfileId: string | null,
  profileId: string,
): Promise<ProfilePage> {
  const { rows } = await db.execute<PageRow>(sql`
    SELECT ${briefColumns},
           (SELECT count(*) FROM looks l WHERE ${profileLook(sql`p.id`)})::int AS looks,
           (SELECT count(*) FROM follows f JOIN profiles o ON o.id = f.follower_profile_id
             WHERE f.followed_profile_id = p.id AND f.deleted_at IS NULL
               AND o.deleted_at IS NULL)::int AS followers,
           (SELECT count(*) FROM follows f JOIN profiles o ON o.id = f.followed_profile_id
             WHERE f.follower_profile_id = p.id AND f.deleted_at IS NULL
               AND o.deleted_at IS NULL)::int AS following,
           EXISTS (SELECT 1 FROM follows f WHERE f.follower_profile_id = ${viewerProfileId}::uuid
                      AND f.followed_profile_id = p.id AND f.deleted_at IS NULL) AS is_following
      FROM profiles p ${avatarJoin}
     WHERE p.id = ${profileId} AND p.deleted_at IS NULL`);
  const row = rows[0];
  if (!row) throw notFound();
  return {
    ...toBrief(storage, row),
    isFollowing: row.is_following,
    counts: { looks: row.looks, followers: row.followers, following: row.following },
  };
}

/** A profile's looks, newest first, 20 per page. 404 for a deleted profile. */
export async function profileLooksPage(
  deps: FeedDeps,
  viewerProfileId: string | null,
  profileId: string,
  cursor: string | undefined,
): Promise<FeedPage> {
  const { rows } = await deps.db.execute(
    sql`SELECT 1 FROM profiles WHERE id = ${profileId} AND deleted_at IS NULL`,
  );
  if (rows.length === 0) throw notFound();
  return newestPage(deps, viewerProfileId, sql`l.author_profile_id = ${profileId}`, cursor);
}
