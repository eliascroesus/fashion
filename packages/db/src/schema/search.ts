import { index, integer, pgTable, text, uniqueIndex } from 'drizzle-orm/pg-core';
import { baseColumns } from './columns.ts';

/**
 * Search's vocabulary: every word in the looks that can be shown (stop words
 * left out) and the extra words for tags (e.g. Swedish `sommar`). Typos are
 * matched against it (pg_trgm) and it gives the suggestions while typing.
 * `lexeme` is the word looks are searched for: the term itself, or the tag a
 * tag word stands for. Rebuilt from the looks every 15 minutes (`search-terms`
 * job), so it is derived data like `feed_snapshots`.
 */
export const searchTerms = pgTable(
  'search_terms',
  {
    ...baseColumns(),
    term: text('term').notNull(),
    lexeme: text('lexeme').notNull(),
    /** Looks with this word: suggestions and popular tags go by it. */
    lookCount: integer('look_count').notNull(),
  },
  (t) => [
    uniqueIndex('search_terms_term_key').on(t.term),
    // Similar words (`%`) and completions (`LIKE 'lin%'`).
    index('search_terms_term_trgm_idx').using('gin', t.term.op('gin_trgm_ops')),
  ],
).enableRLS();
