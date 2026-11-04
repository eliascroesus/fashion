import { type Db, sql } from '@outfitly/db';
import { ApiError } from './errors.ts';

function refuseSelf(profileId: string, targetId: string): void {
  if (profileId === targetId) {
    throw new ApiError(400, 'validation_failed', "You can't follow yourself.");
  }
}

/**
 * Follows `targetId` as `profileId`: one row per pair, so following again
 * brings back an undone follow. Throws 404 for a profile that doesn't exist (any more).
 */
export async function follow(db: Db, profileId: string, targetId: string): Promise<void> {
  refuseSelf(profileId, targetId);
  const { rows } = await db.execute(
    sql`SELECT 1 FROM profiles WHERE id = ${targetId} AND deleted_at IS NULL`,
  );
  if (rows.length === 0) throw new ApiError(404, 'not_found', 'Profile not found.');
  await db.execute(sql`
    INSERT INTO follows (follower_profile_id, followed_profile_id) VALUES (${profileId}, ${targetId})
    ON CONFLICT (follower_profile_id, followed_profile_id)
      DO UPDATE SET deleted_at = NULL, updated_at = now() WHERE follows.deleted_at IS NOT NULL`);
}

/** Stops following; fine if there was nothing to undo. */
export async function unfollow(db: Db, profileId: string, targetId: string): Promise<void> {
  refuseSelf(profileId, targetId);
  await db.execute(sql`
    UPDATE follows SET deleted_at = now(), updated_at = now()
     WHERE follower_profile_id = ${profileId} AND followed_profile_id = ${targetId}
       AND deleted_at IS NULL`);
}
