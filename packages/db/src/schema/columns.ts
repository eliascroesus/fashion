import { sql } from 'drizzle-orm';
import { timestamp, uuid } from 'drizzle-orm/pg-core';

/** Every table has a UUID id and created/updated timestamps. */
export function baseColumns() {
  return {
    id: uuid('id').primaryKey().defaultRandom(),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp('updated_at', { withTimezone: true })
      .notNull()
      .defaultNow()
      // Database clock, same as created_at.
      .$onUpdate(() => sql`now()`),
  };
}

/** Anything a user can remove is soft-deleted. */
export function softDelete() {
  return {
    deletedAt: timestamp('deleted_at', { withTimezone: true }),
  };
}
