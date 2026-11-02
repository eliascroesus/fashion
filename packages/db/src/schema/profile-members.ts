import { sql } from 'drizzle-orm';
import { boolean, index, pgEnum, pgTable, uniqueIndex, uuid } from 'drizzle-orm/pg-core';
import { authUsers } from 'drizzle-orm/supabase';
import { baseColumns } from './columns.ts';
import { profiles } from './profiles.ts';

export const memberRole = pgEnum('member_role', ['owner', 'editor']);

/**
 * Which login (Supabase auth user) can act for which profile, and which of
 * its profiles is currently active. One login can run several profiles.
 */
export const profileMembers = pgTable(
  'profile_members',
  {
    ...baseColumns(),
    userId: uuid('user_id')
      .notNull()
      .references(() => authUsers.id, { onDelete: 'cascade' }),
    profileId: uuid('profile_id')
      .notNull()
      .references(() => profiles.id, { onDelete: 'cascade' }),
    role: memberRole('role').notNull().default('owner'),
    isActive: boolean('is_active').notNull().default(false),
  },
  (t) => [
    uniqueIndex('profile_members_user_profile_key').on(t.userId, t.profileId),
    uniqueIndex('profile_members_one_active_per_user')
      .on(t.userId)
      .where(sql`${t.isActive}`),
    index('profile_members_profile_id_idx').on(t.profileId),
  ],
).enableRLS();
