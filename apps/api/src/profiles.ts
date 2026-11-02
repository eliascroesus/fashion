import {
  and,
  boards,
  type Db,
  eq,
  isNull,
  looks,
  media,
  profileMembers,
  profiles,
  sql,
} from '@outfitly/db';
import { ACTIVE_PROFILE_HEADER, type Me } from '@outfitly/shared';
import type { FastifyRequest } from 'fastify';
import { z } from 'zod';
import { type AuthContext, requireAuth } from './auth.ts';
import { ApiError } from './errors.ts';
import { generateHandle } from './handles.ts';

/** Every profile this login may act as, with its role. Deleted profiles are left out. */
async function memberships(db: Db, userId: string) {
  return db
    .select({
      id: profiles.id,
      handle: profiles.handle,
      displayName: profiles.displayName,
      accountType: profiles.accountType,
      role: profileMembers.role,
      isActive: profileMembers.isActive,
    })
    .from(profileMembers)
    .innerJoin(profiles, eq(profiles.id, profileMembers.profileId))
    .where(and(eq(profileMembers.userId, userId), isNull(profiles.deletedAt)))
    .orderBy(profileMembers.createdAt);
}

export async function getMe(db: Db, auth: AuthContext): Promise<Me> {
  const rows = await memberships(db, auth.userId);
  return {
    userId: auth.userId,
    isAnonymous: auth.isAnonymous,
    activeProfileId: rows.find((r) => r.isActive)?.id ?? null,
    profiles: rows.map(({ id, handle, displayName, accountType, role }) => ({
      id,
      handle,
      displayName,
      accountType,
      role,
    })),
  };
}

const UNIQUE_VIOLATION = '23505';

function isUniqueViolation(error: unknown): boolean {
  const cause = error instanceof Error ? (error.cause ?? error) : error;
  return (cause as { code?: unknown } | null)?.code === UNIQUE_VIOLATION;
}

/**
 * Gives a login its personal profile on first use (guests too) and makes it
 * active. Safe to call any number of times, also concurrently.
 */
export async function ensurePersonalProfile(db: Db, auth: AuthContext): Promise<void> {
  await db.transaction(async (tx) => {
    // One login at a time: concurrent first calls must not create two profiles.
    await tx.execute(
      sql`SELECT pg_advisory_xact_lock(hashtext('profile-setup'), hashtext(${auth.userId}))`,
    );
    const [existing] = await tx
      .select({ id: profileMembers.id })
      .from(profileMembers)
      .where(eq(profileMembers.userId, auth.userId))
      .limit(1);
    if (existing) return;

    for (let attempt = 0; ; attempt++) {
      const handle = generateHandle(attempt < 3 ? 4 : 8);
      try {
        await tx.transaction(async (sp) => {
          const [profile] = await sp
            .insert(profiles)
            .values({ handle, accountType: 'personal' })
            .returning({ id: profiles.id });
          if (!profile) throw new Error('Profile insert returned no row.');
          await sp.insert(profileMembers).values({
            userId: auth.userId,
            profileId: profile.id,
            role: 'owner',
            isActive: true,
          });
        });
        return;
      } catch (error) {
        // Handle taken: try another (the savepoint rolled back the attempt).
        if (!isUniqueViolation(error) || attempt >= 5) throw error;
      }
    }
  });
}

const profileIdHeader = z.uuid();

/**
 * The profile this request acts as. The app names it in the X-Profile-Id
 * header; the server checks this login may act for it. Without the header,
 * the login's active profile is used. Every action (post, save, upload…) is
 * done as this profile.
 */
export async function requireActiveProfile(db: Db, request: FastifyRequest): Promise<string> {
  const { userId } = requireAuth(request);
  const header = request.headers[ACTIVE_PROFILE_HEADER];
  if (header !== undefined) {
    const parsed = profileIdHeader.safeParse(header);
    if (!parsed.success) {
      throw new ApiError(400, 'validation_failed', 'X-Profile-Id must be a profile id.');
    }
    const [row] = await db
      .select({ profileId: profileMembers.profileId })
      .from(profileMembers)
      .innerJoin(profiles, eq(profiles.id, profileMembers.profileId))
      .where(
        and(
          eq(profileMembers.userId, userId),
          eq(profileMembers.profileId, parsed.data),
          isNull(profiles.deletedAt),
        ),
      );
    if (!row) throw new ApiError(403, 'forbidden', 'This login cannot act as that profile.');
    return row.profileId;
  }

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

type Tx = Parameters<Parameters<Db['transaction']>[0]>[0];

/**
 * Moves a guest's rows in a "one row per profile and X" table to the account,
 * except rows the account already has (same `key`). Those duplicates stay on
 * the closed guest profile. With `skipKey`, rows whose key is the account
 * itself are left too (following yourself isn't allowed).
 */
async function moveUnlessDuplicate(
  tx: Tx,
  table: string,
  column: string,
  key: string,
  fromProfileId: string,
  toProfileId: string,
  { skipKey = false } = {},
): Promise<void> {
  const [t, c, k] = [sql.identifier(table), sql.identifier(column), sql.identifier(key)];
  await tx.execute(sql`
    UPDATE ${t} AS mine SET ${c} = ${toProfileId}, updated_at = now()
     WHERE mine.${c} = ${fromProfileId}
       ${skipKey ? sql`AND mine.${k} <> ${toProfileId}` : sql``}
       AND NOT EXISTS (SELECT 1 FROM ${t} AS theirs
                        WHERE theirs.${c} = ${toProfileId} AND theirs.${k} = mine.${k})`);
  // The guest did it and the account had undone it (soft-deleted): the guest's is newer.
  await tx.execute(sql`
    UPDATE ${t} AS theirs SET deleted_at = NULL, updated_at = now()
      FROM ${t} AS mine
     WHERE theirs.${c} = ${toProfileId} AND theirs.deleted_at IS NOT NULL
       AND mine.${c} = ${fromProfileId} AND mine.${k} = theirs.${k} AND mine.deleted_at IS NULL`);
}

/** Like moveUnlessDuplicate, for tables without soft delete. */
async function moveMissing(
  tx: Tx,
  table: string,
  column: string,
  key: string,
  fromProfileId: string,
  toProfileId: string,
): Promise<void> {
  const [t, c, k] = [sql.identifier(table), sql.identifier(column), sql.identifier(key)];
  await tx.execute(sql`
    UPDATE ${t} AS mine SET ${c} = ${toProfileId}, updated_at = now()
     WHERE mine.${c} = ${fromProfileId}
       AND NOT EXISTS (SELECT 1 FROM ${t} AS theirs
                        WHERE theirs.${c} = ${toProfileId} AND theirs.${k} = mine.${k})`);
}

/**
 * Moves everything a guest made to another profile. Every table whose rows
 * belong to a profile must be listed here (a test checks this).
 */
async function moveProfileContent(
  tx: Tx,
  fromProfileId: string,
  toProfileId: string,
): Promise<void> {
  // Owned outright: everything moves (board items go with their board).
  await tx
    .update(media)
    .set({ ownerProfileId: toProfileId })
    .where(eq(media.ownerProfileId, fromProfileId));
  await tx
    .update(looks)
    .set({ authorProfileId: toProfileId })
    .where(eq(looks.authorProfileId, fromProfileId));
  await tx
    .update(boards)
    .set({ profileId: toProfileId })
    .where(eq(boards.profileId, fromProfileId));

  // One row per pair: the account keeps its own, and gets the guest's new ones.
  await moveUnlessDuplicate(tx, 'saves', 'profile_id', 'look_id', fromProfileId, toProfileId);
  const follows = ['follows', 'follower_profile_id', 'followed_profile_id'] as const;
  await moveUnlessDuplicate(tx, ...follows, fromProfileId, toProfileId, { skipKey: true });
  const followers = ['follows', 'followed_profile_id', 'follower_profile_id'] as const;
  await moveUnlessDuplicate(tx, ...followers, fromProfileId, toProfileId, { skipKey: true });
  await moveMissing(tx, 'swipes', 'profile_id', 'look_id', fromProfileId, toProfileId);
  await moveMissing(tx, 'seen', 'profile_id', 'look_id', fromProfileId, toProfileId);
  // The account's own taste wins; the guest's picks only move if it has none.
  await tx.execute(sql`
    UPDATE taste_profiles SET profile_id = ${toProfileId}, updated_at = now()
     WHERE profile_id = ${fromProfileId}
       AND NOT EXISTS (SELECT 1 FROM taste_profiles WHERE profile_id = ${toProfileId})`);
}

/** Database columns that point at a profile and are handled by moveProfileContent (or by membership). */
export const PROFILE_REFERENCES_HANDLED_BY_MERGE = [
  'boards.profile_id',
  'follows.followed_profile_id',
  'follows.follower_profile_id',
  'looks.author_profile_id',
  'media.owner_profile_id',
  'profile_members.profile_id',
  'saves.profile_id',
  'seen.profile_id',
  'swipes.profile_id',
  'taste_profiles.profile_id',
];

export class NotAGuestError extends Error {
  constructor() {
    super('That login is no longer a guest.');
    this.name = 'NotAGuestError';
  }
}

/**
 * A guest signed in to an account that already existed: their guest
 * profiles' content moves to `targetProfileId`, and the guest profiles are
 * closed. Returns false if the guest had nothing left to move.
 */
export async function mergeGuestInto(
  db: Db,
  guestUserId: string,
  targetProfileId: string,
): Promise<boolean> {
  return db.transaction(async (tx) => {
    // Trust the login's current state, not the token: a guest token stays valid
    // for up to an hour after that guest upgraded to a real account.
    const { rows } = await tx.execute<{ is_anonymous: boolean }>(
      sql`SELECT is_anonymous FROM auth.users WHERE id = ${guestUserId} FOR UPDATE`,
    );
    if (rows[0]?.is_anonymous !== true) throw new NotAGuestError();

    const guestProfiles = await tx
      .select({ profileId: profileMembers.profileId })
      .from(profileMembers)
      .innerJoin(profiles, eq(profiles.id, profileMembers.profileId))
      .where(
        and(
          eq(profileMembers.userId, guestUserId),
          eq(profileMembers.role, 'owner'),
          isNull(profiles.deletedAt),
        ),
      );
    for (const { profileId } of guestProfiles) {
      if (profileId === targetProfileId) continue;
      await moveProfileContent(tx, profileId, targetProfileId);
      await tx
        .update(profiles)
        .set({ deletedAt: sql`now()` })
        .where(eq(profiles.id, profileId));
    }
    await tx.delete(profileMembers).where(eq(profileMembers.userId, guestUserId));
    return guestProfiles.length > 0;
  });
}
