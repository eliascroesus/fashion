import { sql } from 'drizzle-orm';
import {
  index,
  integer,
  pgEnum,
  pgTable,
  text,
  timestamp,
  uniqueIndex,
  uuid,
} from 'drizzle-orm/pg-core';
import { baseColumns } from './columns.ts';

export const idempotencyStatus = pgEnum('idempotency_status', ['in_progress', 'completed']);

/**
 * One row per client write (scoped to the login that sent it), so a retry or
 * double-tap replays the first response instead of doing the work twice.
 * Rows expire after a day and are deleted by a background job.
 */
export const idempotencyKeys = pgTable(
  'idempotency_keys',
  {
    ...baseColumns(),
    userId: uuid('user_id').notNull(),
    key: text('key').notNull(),
    requestHash: text('request_hash').notNull(),
    status: idempotencyStatus('status').notNull().default('in_progress'),
    responseStatus: integer('response_status'),
    responseBody: text('response_body'),
    expiresAt: timestamp('expires_at', { withTimezone: true })
      .notNull()
      .default(sql`now() + interval '24 hours'`),
  },
  (t) => [
    uniqueIndex('idempotency_keys_user_key').on(t.userId, t.key),
    index('idempotency_keys_expires_at_idx').on(t.expiresAt),
  ],
).enableRLS();
