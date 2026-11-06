import { FINGERPRINT_DIMENSIONS } from '@outfitly/shared';
import { sql } from 'drizzle-orm';
import { halfvec, text, timestamp, uuid } from 'drizzle-orm/pg-core';

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

/**
 * A fingerprint: how an image (or words) looks to Marqo-FashionSigLIP. Nearest
 * ones are found by cosine distance (`<=>`) through an HNSW index. Stored as
 * half-precision numbers: half the disk and index memory, and ranking by
 * cosine is the same in practice (migration 0011). `embedding_model` says which
 * model made it, so a model change can be found and redone (migration 0012).
 */
export function fingerprint() {
  return {
    embedding: halfvec('embedding', { dimensions: FINGERPRINT_DIMENSIONS }),
    embeddingModel: text('embedding_model'),
  };
}
