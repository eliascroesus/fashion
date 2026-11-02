import { sql } from 'drizzle-orm';
import { boolean, check, pgTable, text, uniqueIndex, uuid } from 'drizzle-orm/pg-core';
import { baseColumns } from './columns.ts';

/** On/off switches per feature. A flag can be on for listed tester profiles only. */
export const featureFlags = pgTable(
  'feature_flags',
  {
    ...baseColumns(),
    key: text('key').notNull(),
    description: text('description'),
    enabled: boolean('enabled').notNull().default(false),
    enabledProfileIds: uuid('enabled_profile_ids')
      .array()
      .notNull()
      .default(sql`'{}'::uuid[]`),
  },
  (t) => [
    uniqueIndex('feature_flags_key_key').on(t.key),
    check('feature_flags_key_format', sql`${t.key} ~ '^[a-z0-9_]+$'`),
  ],
).enableRLS();
