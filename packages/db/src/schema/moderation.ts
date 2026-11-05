import { sql } from 'drizzle-orm';
import {
  check,
  index,
  jsonb,
  pgEnum,
  pgTable,
  text,
  timestamp,
  uniqueIndex,
  uuid,
} from 'drizzle-orm/pg-core';
import { baseColumns } from './columns.ts';
import { media, safetyFlag } from './media.ts';
import { lookItems } from './products.ts';

/**
 * What is waiting: photos the AI flagged (Step 3.3) and shop links the
 * automatic check couldn't decide (Step 3.5); reports come in Phase 4.
 */
export const moderationKind = pgEnum('moderation_kind', ['photo_flagged', 'link_check']);
export const moderationStatus = pgEnum('moderation_status', ['open', 'approved', 'removed']);

/**
 * Things waiting for a person to look at them (the `/admin` review page,
 * Phase 4). A flagged photo's looks are hidden; `details.looks` remembers
 * each look's status before, so approving can put it back. A link check item
 * is about one look item (status `review`): is this the same piece?
 */
export const moderationQueue = pgTable(
  'moderation_queue',
  {
    ...baseColumns(),
    kind: moderationKind('kind').notNull(),
    mediaId: uuid('media_id').references(() => media.id, { onDelete: 'cascade' }),
    lookItemId: uuid('look_item_id').references(() => lookItems.id, { onDelete: 'cascade' }),
    reasons: safetyFlag('reasons')
      .array()
      .notNull()
      .default(sql`'{}'`),
    details: jsonb('details').$type<Record<string, unknown>>().notNull().default({}),
    status: moderationStatus('status').notNull().default('open'),
    resolvedAt: timestamp('resolved_at', { withTimezone: true }),
    note: text('note'),
  },
  (t) => [
    // One open item per photo, however often its job is retried.
    uniqueIndex('moderation_queue_open_media_key')
      .on(t.kind, t.mediaId)
      .where(sql`${t.status} = 'open'`),
    // One open item per look item, however often its check runs.
    uniqueIndex('moderation_queue_open_look_item_key')
      .on(t.kind, t.lookItemId)
      .where(sql`${t.status} = 'open'`),
    index('moderation_queue_look_item_id_idx')
      .on(t.lookItemId)
      .where(sql`${t.lookItemId} is not null`),
    index('moderation_queue_open_idx')
      .on(t.createdAt)
      .where(sql`${t.status} = 'open'`),
    check(
      'moderation_queue_has_subject',
      sql`${t.mediaId} is not null or ${t.lookItemId} is not null`,
    ),
    check('moderation_queue_details_is_object', sql`jsonb_typeof(${t.details}) = 'object'`),
    check(
      'moderation_queue_resolved_has_time',
      sql`(${t.status} = 'open') = (${t.resolvedAt} is null)`,
    ),
  ],
).enableRLS();
