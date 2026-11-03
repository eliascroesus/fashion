import { LOOK_STATUSES, MAX_LOOK_PHOTOS, OCCASIONS, SEASONS } from '@outfitly/shared';
import { sql } from 'drizzle-orm';
import {
  type AnyPgColumn,
  boolean,
  check,
  doublePrecision,
  index,
  pgEnum,
  pgTable,
  smallint,
  text,
  timestamp,
  uniqueIndex,
  uuid,
} from 'drizzle-orm/pg-core';
import { baseColumns, softDelete } from './columns.ts';
import { media } from './media.ts';
import { profiles } from './profiles.ts';

export const lookStatus = pgEnum('look_status', LOOK_STATUSES);
export const lookOccasion = pgEnum('look_occasion', OCCASIONS);
export const lookSeason = pgEnum('look_season', SEASONS);

/**
 * A posted outfit: the core content unit. Photos are in `look_media`.
 * `is_sponsored` stays false until ads exist (Phase 9).
 */
export const looks = pgTable(
  'looks',
  {
    ...baseColumns(),
    authorProfileId: uuid('author_profile_id')
      .notNull()
      .references((): AnyPgColumn => profiles.id),
    caption: text('caption'),
    status: lookStatus('status').notNull().default('draft'),
    /** Public URL part: readable caption text plus part of the id (see `lookSlug`). */
    slug: text('slug').notNull(),
    occasionTags: lookOccasion('occasion_tags')
      .array()
      .notNull()
      .default(sql`'{}'`),
    seasonTags: lookSeason('season_tags')
      .array()
      .notNull()
      .default(sql`'{}'`),
    aiDescription: text('ai_description'),
    popularityScore: doublePrecision('popularity_score').notNull().default(0),
    isSponsored: boolean('is_sponsored').notNull().default(false),
    /** When the look first went public; feeds sort on it. */
    publishedAt: timestamp('published_at', { withTimezone: true }),
    ...softDelete(),
  },
  (t) => [
    uniqueIndex('looks_slug_key').on(t.slug),
    index('looks_author_profile_id_idx').on(t.authorProfileId),
    // Feeds only read published looks; each pool walks one of these in order.
    // NULLS FIRST is what a plain `ORDER BY ... DESC` sorts, so queries match the index.
    index('looks_feed_recent_idx')
      .on(t.publishedAt.desc().nullsFirst(), t.id.desc().nullsFirst())
      .where(sql`${t.status} = 'published' and ${t.deletedAt} is null`),
    index('looks_feed_popular_idx')
      .on(
        t.popularityScore.desc().nullsFirst(),
        t.publishedAt.desc().nullsFirst(),
        t.id.desc().nullsFirst(),
      )
      .where(sql`${t.status} = 'published' and ${t.deletedAt} is null`),
    index('looks_feed_author_idx')
      .on(t.authorProfileId, t.publishedAt.desc().nullsFirst(), t.id.desc().nullsFirst())
      .where(sql`${t.status} = 'published' and ${t.deletedAt} is null`),
    check(
      'looks_published_has_time',
      sql`${t.status} <> 'published' or ${t.publishedAt} is not null`,
    ),
    check('looks_slug_format', sql`${t.slug} ~ '^[a-z0-9]+(-[a-z0-9]+)*$'`),
  ],
).enableRLS();

/** Which photos belong to a look, in order (position 0 is the cover). Rows are links: hard-deleted. */
export const lookMedia = pgTable(
  'look_media',
  {
    ...baseColumns(),
    lookId: uuid('look_id')
      .notNull()
      .references(() => looks.id, { onDelete: 'cascade' }),
    mediaId: uuid('media_id')
      .notNull()
      .references(() => media.id),
    position: smallint('position').notNull(),
  },
  (t) => [
    uniqueIndex('look_media_look_position_key').on(t.lookId, t.position),
    uniqueIndex('look_media_look_media_key').on(t.lookId, t.mediaId),
    index('look_media_media_id_idx').on(t.mediaId),
    check(
      'look_media_position_range',
      sql`${t.position} between 0 and ${sql.raw(String(MAX_LOOK_PHOTOS - 1))}`,
    ),
  ],
).enableRLS();
