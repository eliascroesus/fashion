import { sql } from 'drizzle-orm';
import {
  type AnyPgColumn,
  check,
  index,
  pgEnum,
  pgTable,
  text,
  timestamp,
  uniqueIndex,
  uuid,
} from 'drizzle-orm/pg-core';
import { baseColumns, softDelete } from './columns.ts';
import { looks } from './looks.ts';
import { profiles } from './profiles.ts';

/**
 * Profile-owned tables below must also be handled when a guest's content
 * moves to an existing account (`moveProfileContent` in the API).
 * Unique pairs keep one row each; removing sets `deleted_at` and doing it
 * again clears it.
 */

/** Which profile follows which. */
export const follows = pgTable(
  'follows',
  {
    ...baseColumns(),
    followerProfileId: uuid('follower_profile_id')
      .notNull()
      .references((): AnyPgColumn => profiles.id),
    followedProfileId: uuid('followed_profile_id')
      .notNull()
      .references((): AnyPgColumn => profiles.id),
    ...softDelete(),
  },
  (t) => [
    uniqueIndex('follows_follower_followed_key').on(t.followerProfileId, t.followedProfileId),
    index('follows_followed_profile_id_idx').on(t.followedProfileId),
    check('follows_not_self', sql`${t.followerProfileId} <> ${t.followedProfileId}`),
  ],
).enableRLS();

/** Every look a profile saved (the main habit metric). */
export const saves = pgTable(
  'saves',
  {
    ...baseColumns(),
    profileId: uuid('profile_id')
      .notNull()
      .references((): AnyPgColumn => profiles.id),
    lookId: uuid('look_id')
      .notNull()
      .references(() => looks.id, { onDelete: 'cascade' }),
    ...softDelete(),
  },
  (t) => [
    uniqueIndex('saves_profile_look_key').on(t.profileId, t.lookId),
    index('saves_look_id_idx').on(t.lookId),
  ],
).enableRLS();

/** A profile's named collection of looks. */
export const boards = pgTable(
  'boards',
  {
    ...baseColumns(),
    profileId: uuid('profile_id')
      .notNull()
      .references((): AnyPgColumn => profiles.id),
    name: text('name').notNull(),
    ...softDelete(),
  },
  (t) => [
    index('boards_profile_id_idx').on(t.profileId),
    check('boards_name_length', sql`char_length(${t.name}) between 1 and 50`),
  ],
).enableRLS();

/** Looks on a board. Belongs to the board's profile. */
export const boardItems = pgTable(
  'board_items',
  {
    ...baseColumns(),
    boardId: uuid('board_id')
      .notNull()
      .references(() => boards.id, { onDelete: 'cascade' }),
    lookId: uuid('look_id')
      .notNull()
      .references(() => looks.id, { onDelete: 'cascade' }),
    ...softDelete(),
  },
  (t) => [
    uniqueIndex('board_items_board_look_key').on(t.boardId, t.lookId),
    index('board_items_look_id_idx').on(t.lookId),
  ],
).enableRLS();

export const swipeKind = pgEnum('swipe_kind', ['skip', 'see_less']);

/** A profile's latest "skip" or "see less" on a look (feed signal; the full history is in `events`). */
export const swipes = pgTable(
  'swipes',
  {
    ...baseColumns(),
    profileId: uuid('profile_id')
      .notNull()
      .references((): AnyPgColumn => profiles.id),
    lookId: uuid('look_id')
      .notNull()
      .references(() => looks.id, { onDelete: 'cascade' }),
    kind: swipeKind('kind').notNull(),
  },
  (t) => [uniqueIndex('swipes_profile_look_key').on(t.profileId, t.lookId)],
).enableRLS();

/** Looks shown to a profile recently, so feeds don't repeat them. Kept for 7 days. */
export const seen = pgTable(
  'seen',
  {
    ...baseColumns(),
    profileId: uuid('profile_id')
      .notNull()
      .references((): AnyPgColumn => profiles.id),
    lookId: uuid('look_id')
      .notNull()
      .references(() => looks.id, { onDelete: 'cascade' }),
    lastSeenAt: timestamp('last_seen_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    uniqueIndex('seen_profile_look_key').on(t.profileId, t.lookId),
    index('seen_profile_last_seen_idx').on(t.profileId, t.lastSeenAt),
  ],
).enableRLS();

/** Styles and brands a profile picked in onboarding; tunes the first feed. */
export const tasteProfiles = pgTable(
  'taste_profiles',
  {
    ...baseColumns(),
    profileId: uuid('profile_id')
      .notNull()
      .references((): AnyPgColumn => profiles.id),
    styles: text('styles')
      .array()
      .notNull()
      .default(sql`'{}'::text[]`),
    brands: text('brands')
      .array()
      .notNull()
      .default(sql`'{}'::text[]`),
  },
  (t) => [uniqueIndex('taste_profiles_profile_id_key').on(t.profileId)],
).enableRLS();
