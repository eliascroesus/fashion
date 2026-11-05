import { sql } from 'drizzle-orm';
import { check, index, integer, pgEnum, pgTable, text, uuid } from 'drizzle-orm/pg-core';
import { baseColumns } from './columns.ts';

export const aiCallPurpose = pgEnum('ai_call_purpose', ['spot_garments', 'link_check']);
/** ok = a usable answer; blocked = refused for safety; invalid = unusable answer; failed = no answer. */
export const aiCallStatus = pgEnum('ai_call_status', ['ok', 'blocked', 'invalid', 'failed']);

/**
 * Every paid AI call (Gemini), answered or not: what for, which model and
 * prompt version, tokens and cost. The daily spend cap adds up today's cost.
 * Cost is in millionths of a dollar. No foreign keys, like `events`: the log
 * outlives what it was about.
 */
export const aiCalls = pgTable(
  'ai_calls',
  {
    ...baseColumns(),
    purpose: aiCallPurpose('purpose').notNull(),
    /** The model we asked for (`GEMINI_MODEL`). */
    model: text('model').notNull(),
    /** The exact version that answered, as Gemini reports it. */
    modelVersion: text('model_version'),
    promptVersion: text('prompt_version').notNull(),
    status: aiCallStatus('status').notNull(),
    inputTokens: integer('input_tokens').notNull().default(0),
    outputTokens: integer('output_tokens').notNull().default(0),
    /** Thinking tokens, billed as output (included in the cost, not in `output_tokens`). */
    thinkingTokens: integer('thinking_tokens').notNull().default(0),
    costMicros: integer('cost_micros').notNull().default(0),
    durationMs: integer('duration_ms').notNull(),
    httpStatus: integer('http_status'),
    error: text('error'),
    mediaId: uuid('media_id'),
    lookId: uuid('look_id'),
  },
  (t) => [
    index('ai_calls_created_at_idx').on(t.createdAt),
    index('ai_calls_media_id_idx').on(t.mediaId),
    check(
      'ai_calls_counts_not_negative',
      sql`${t.inputTokens} >= 0 and ${t.outputTokens} >= 0 and ${t.thinkingTokens} >= 0 and ${t.costMicros} >= 0 and ${t.durationMs} >= 0`,
    ),
  ],
).enableRLS();
