import { sql } from 'drizzle-orm';
import {
  type AnyPgColumn,
  boolean,
  check,
  index,
  pgEnum,
  pgTable,
  text,
  uniqueIndex,
  uuid,
} from 'drizzle-orm/pg-core';
import { baseColumns, softDelete } from './columns.ts';
import { media } from './media.ts';

export const accountType = pgEnum('account_type', ['personal', 'creator', 'business']);

/**
 * A public identity (Instagram-style). A login is NOT a profile: logins reach
 * profiles through `profile_members`, and every action is done as a profile.
 */
export const profiles = pgTable(
  'profiles',
  {
    ...baseColumns(),
    handle: text('handle').notNull(),
    displayName: text('display_name'),
    avatarMediaId: uuid('avatar_media_id').references((): AnyPgColumn => media.id, {
      onDelete: 'set null',
    }),
    accountType: accountType('account_type').notNull().default('personal'),
    // Creator accounts
    creatorCategory: text('creator_category'),
    // Business / brand accounts
    brandName: text('brand_name'),
    logoMediaId: uuid('logo_media_id').references((): AnyPgColumn => media.id, {
      onDelete: 'set null',
    }),
    websiteUrl: text('website_url'),
    isVerified: boolean('is_verified').notNull().default(false),
    ...softDelete(),
  },
  (t) => [
    uniqueIndex('profiles_handle_key').on(t.handle),
    // People in search suggestions: similar handles, and names containing what's typed.
    index('profiles_handle_trgm_idx').using('gin', t.handle.op('gin_trgm_ops')),
    index('profiles_display_name_trgm_idx').using('gin', sql`lower(${t.displayName}) gin_trgm_ops`),
    check('profiles_handle_format', sql`${t.handle} ~ '^[a-z0-9._]{3,30}$'`),
  ],
).enableRLS();
