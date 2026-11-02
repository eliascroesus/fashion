import { and, type Db, eq, isNull, profileMembers, profiles } from '@outfitly/db';
import type { FastifyRequest } from 'fastify';
import { requireAuth } from './auth.ts';
import { ApiError } from './errors.ts';

/**
 * The profile this login is currently acting as, looked up server-side from
 * profile_members. Every action (post, save, upload…) is done as this profile.
 */
export async function requireActiveProfile(db: Db, request: FastifyRequest): Promise<string> {
  const { userId } = requireAuth(request);
  const [row] = await db
    .select({ profileId: profileMembers.profileId })
    .from(profileMembers)
    .innerJoin(profiles, eq(profiles.id, profileMembers.profileId))
    .where(
      and(
        eq(profileMembers.userId, userId),
        eq(profileMembers.isActive, true),
        isNull(profiles.deletedAt),
      ),
    );
  if (!row) throw new ApiError(403, 'forbidden', 'This login has no active profile yet.');
  return row.profileId;
}
