import { sql } from 'drizzle-orm';
import { check, jsonb, pgTable, text, uniqueIndex } from 'drizzle-orm/pg-core';
import { baseColumns } from './columns.ts';

/**
 * Numbers that tune the product without a deploy (e.g. the link check's
 * score thresholds, Step 3.5). One row per setting; `value` is checked by the
 * code that reads it. Defaults are inserted by the migration that needs them.
 */
export const settings = pgTable(
  'settings',
  {
    ...baseColumns(),
    key: text('key').notNull(),
    value: jsonb('value').$type<unknown>().notNull(),
    description: text('description'),
  },
  (t) => [
    uniqueIndex('settings_key_key').on(t.key),
    check('settings_key_format', sql`${t.key} ~ '^[a-z0-9_]+$'`),
  ],
).enableRLS();
