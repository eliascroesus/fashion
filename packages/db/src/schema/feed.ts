import { sql } from 'drizzle-orm';
import { boolean, check, index, pgEnum, pgTable, text, uuid } from 'drizzle-orm/pg-core';
import { baseColumns } from './columns.ts';

export const lookListKind = pgEnum('look_list_kind', ['similar', 'search']);

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

/**
 * The ranked list behind one "More like this" (`similar`, keyed by the look's
 * id) or one search (`search`, keyed by its words): page 1 makes it, later
 * pages read on from it, so nothing repeats or gets skipped although
 * nearest-fingerprint search is approximate and the diversity rules reorder.
 * `profile_id` is null for lists anyone may reuse for a while: "More like
 * this" for logged-out visitors, and every search (search isn't personal).
 * `complete` is false for a list made without fingerprints: a search the
 * fingerprint service didn't answer (words only; never reused, so a sleeping
 * service doesn't spoil the next visitors' lists) or a look without a
 * fingerprint yet (tags only; reused for a few minutes only). A short-lived
 * cache like `feed_snapshots`: deleted after a day, no foreign keys.
 */
export const lookLists = pgTable(
  'look_lists',
  {
    ...baseColumns(),
    kind: lookListKind('kind').notNull(),
    key: text('key').notNull(),
    profileId: uuid('profile_id'),
    lookIds: uuid('look_ids').array().notNull(),
    complete: boolean('complete').notNull(),
  },
  (t) => [
    index('look_lists_created_at_idx').on(t.createdAt),
    // The newest list of a kind for a key, shared (profile_id IS NULL) or a profile's own.
    index('look_lists_lookup_idx').on(t.kind, t.key, t.profileId, t.createdAt),
    // A profile's newest lists of a kind (it keeps a few; older ones are deleted on each save).
    index('look_lists_profile_kind_idx').on(t.profileId, t.kind, t.createdAt),
    check('look_lists_key_length', sql`octet_length(${t.key}) BETWEEN 1 AND 400`),
  ],
).enableRLS();
