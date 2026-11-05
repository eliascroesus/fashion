import { sql } from 'drizzle-orm';
import { SAFETY_FLAGS } from '@outfitly/shared';
import {
  type AnyPgColumn,
  check,
  index,
  integer,
  pgEnum,
  pgTable,
  text,
  timestamp,
  uniqueIndex,
  uuid,
} from 'drizzle-orm/pg-core';
import { baseColumns, fingerprint, softDelete } from './columns.ts';
import { profiles } from './profiles.ts';

export const mediaStatus = pgEnum('media_status', ['pending', 'processing', 'ready', 'failed']);
/** Garment spotting (Step 3.3): null = not spotted yet. */
export const mediaSpotStatus = pgEnum('media_spot_status', ['done', 'flagged', 'failed']);
export const safetyFlag = pgEnum('safety_flag', SAFETY_FLAGS);

/**
 * One uploaded photo. The original stays private; only the three WebP sizes
 * are served. Width, height and thumbhash let the grid reserve space up front.
 * A look's photos are read by the AI once (Step 3.3): its garments are in
 * `garments`, its sentence, search words and safety flags here, and the whole
 * photo's fingerprint in `embedding`.
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
    spotStatus: mediaSpotStatus('spot_status'),
    spottedAt: timestamp('spotted_at', { withTimezone: true }),
    aiDescription: text('ai_description'),
    aiTags: text('ai_tags')
      .array()
      .notNull()
      .default(sql`'{}'`),
    safetyFlags: safetyFlag('safety_flags')
      .array()
      .notNull()
      .default(sql`'{}'`),
    ...fingerprint(),
    ...softDelete(),
  },
  (t) => [
    uniqueIndex('media_original_key_key').on(t.originalKey),
    index('media_owner_profile_id_idx').on(t.ownerProfileId),
    index('media_embedding_idx').using('hnsw', t.embedding.op('halfvec_cosine_ops')),
    check(
      'media_ready_is_complete',
      sql`${t.status} <> 'ready' or (${t.key1080} is not null and ${t.key600} is not null and ${t.key300} is not null and ${t.width} > 0 and ${t.height} > 0 and ${t.thumbhash} is not null and ${t.dominantColor} is not null)`,
    ),
    check('media_dominant_color_format', sql`${t.dominantColor} ~ '^#[0-9a-f]{6}$'`),
  ],
).enableRLS();
