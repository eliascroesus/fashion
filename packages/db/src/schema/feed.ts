import { index, pgTable, text, uuid } from 'drizzle-orm/pg-core';
import { baseColumns } from './columns.ts';

/**
 * The ranked list of looks behind one For You scroll. Page 1 makes it (or, for
 * logged-out visitors, picks one of a few shared recent ones) and later pages
 * read from it, so a look never repeats or gets skipped while scores change.
 * A short-lived cache, deleted after a day. No foreign keys (like `events`);
 * `profile_id` is null for the shared logged-out lists. Not moved when a guest
 * merges into an account: the guest's scroll simply starts a new list.
 * `taste_key` marks a shared list made for the styles a logged-out phone picked
 * (e.g. `minimal,streetwear`); null for the plain shared lists and profiles' lists.
 */
export const feedSnapshots = pgTable(
  'feed_snapshots',
  {
    ...baseColumns(),
    profileId: uuid('profile_id'),
    lookIds: uuid('look_ids').array().notNull(),
    tasteKey: text('taste_key'),
  },
  (t) => [
    index('feed_snapshots_created_at_idx').on(t.createdAt),
    // A profile's newest lists, and the shared logged-out ones (profile_id IS NULL).
    index('feed_snapshots_profile_created_at_idx').on(t.profileId, t.createdAt),
  ],
).enableRLS();
