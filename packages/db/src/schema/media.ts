import { sql } from 'drizzle-orm';
import {
  type AnyPgColumn,
  check,
  index,
  integer,
  pgEnum,
  pgTable,
  text,
  uniqueIndex,
  uuid,
} from 'drizzle-orm/pg-core';
import { baseColumns, softDelete } from './columns.ts';
import { profiles } from './profiles.ts';

export const mediaStatus = pgEnum('media_status', ['pending', 'processing', 'ready', 'failed']);

/**
 * One uploaded photo. The original stays private; only the three WebP sizes
 * are served. Width, height and thumbhash let the grid reserve space up front.
 */
export const media = pgTable(
  'media',
  {
    ...baseColumns(),
    ownerProfileId: uuid('owner_profile_id')
      .notNull()
      .references((): AnyPgColumn => profiles.id),
    status: mediaStatus('status').notNull().default('pending'),
    originalKey: text('original_key').notNull(),
    contentType: text('content_type'),
    byteSize: integer('byte_size'),
    key1080: text('key_1080'),
    key600: text('key_600'),
    key300: text('key_300'),
    width: integer('width'),
    height: integer('height'),
    thumbhash: text('thumbhash'),
    dominantColor: text('dominant_color'),
    error: text('error'),
    ...softDelete(),
  },
  (t) => [
    uniqueIndex('media_original_key_key').on(t.originalKey),
    index('media_owner_profile_id_idx').on(t.ownerProfileId),
    check(
      'media_ready_is_complete',
      sql`${t.status} <> 'ready' or (${t.key1080} is not null and ${t.key600} is not null and ${t.key300} is not null and ${t.width} > 0 and ${t.height} > 0 and ${t.thumbhash} is not null and ${t.dominantColor} is not null)`,
    ),
    check('media_dominant_color_format', sql`${t.dominantColor} ~ '^#[0-9a-f]{6}$'`),
  ],
).enableRLS();
