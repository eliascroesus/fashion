import { sql } from 'drizzle-orm';
import {
  check,
  integer,
  jsonb,
  pgEnum,
  pgTable,
  primaryKey,
  text,
  timestamp,
  uuid,
} from 'drizzle-orm/pg-core';

export const clientPlatform = pgEnum('client_platform', ['ios', 'android', 'web']);

/**
 * Every impression (with feed position), open, save, share and click: growth
 * metrics and stats now, ad sales later. Append-only.
 *
 * Split into one partition per month on `created_at` (the migration adds
 * `PARTITION BY RANGE`; `ensureEventPartitions` makes months ahead), so the
 * key includes `created_at`. No foreign keys: events are history and stay
 * with the profile that made them.
 */
export const events = pgTable(
  'events',
  {
    id: uuid('id').notNull().defaultRandom(),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp('updated_at', { withTimezone: true })
      .notNull()
      .defaultNow()
      .$onUpdate(() => sql`now()`),
    /** One of EVENT_NAMES in @outfitly/shared. */
    name: text('name').notNull(),
    /** Who did it; null for logged-out visitors (then `session_id` is set). */
    profileId: uuid('profile_id'),
    sessionId: uuid('session_id'),
    lookId: uuid('look_id'),
    /** Place in the feed (0-based) for impressions and opens from a feed. */
    position: integer('position'),
    /** Which screen or feed, e.g. `home`, `search`, `profile`, `board`. */
    source: text('source'),
    platform: clientPlatform('platform'),
    properties: jsonb('properties').notNull().default({}),
  },
  (t) => [
    primaryKey({ name: 'events_pkey', columns: [t.createdAt, t.id] }),
    check('events_name_format', sql`${t.name} ~ '^[a-z_]{1,40}$'`),
  ],
).enableRLS();
