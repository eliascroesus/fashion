import { type Db, type SQL, sql } from '@outfitly/db';
import {
  FEED_PAGE_SIZE,
  type FeedPage,
  LOOK_TAGS,
  type LookTag,
  type PopularTags,
  searchWords,
  STOP_WORDS,
  type Suggestions,
  TAG_SEARCH_WORDS,
} from '@outfitly/shared';
import { z } from 'zod';
import {
  decodeCursor,
  encodeCursor,
  type FeedDeps,
  loadCards,
  microsText,
  microsTime,
  showableLook,
} from './feed/cards.ts';
import { avatarJoin, briefColumns, type BriefRow, profileLook, toBrief } from './profile-page.ts';

/** A vocabulary word at least this similar (pg_trgm, 0–1) to a typed word counts as its typo. */
const TYPO_SIMILARITY = 0.4;
/** Shorter words are never matched as typos (too few letters to tell), nor searched as a prefix. */
const TYPO_MIN_LENGTH = 3;
/** Each typed word also finds up to this many vocabulary words (typos, tag words). */
const MAX_ALTERNATIVES = 5;
const MAX_SUGGESTED_TERMS = 8;
const MAX_SUGGESTED_PROFILES = 3;
const MAX_POPULAR_TAGS = 12;

/** pg_trgm lives in the `extensions` schema; named in full so the search_path never matters. */
const similar = (a: SQL, b: SQL) => sql`${a} OPERATOR(extensions.%) ${b}`;
const similarity = (a: SQL, b: SQL) => sql`extensions.similarity(${a}, ${b})`;

function textArray(values: readonly string[]): SQL {
  if (values.length === 0) return sql`'{}'::text[]`;
  const list = sql.join(
    values.map((value) => sql`${value}`),
    sql`, `,
  );
  return sql`ARRAY[${list}]::text[]`;
}

/** `text` and anything after it, for LIKE (its own `%`, `_` and `\` matched literally). */
function likePrefix(text: string): string {
  return `${text.replace(/[\\%_]/g, '\\$&')}%`;
}

/** Every tag word (e.g. `sommar`) and the tag it stands for. */
const TAG_WORDS = LOOK_TAGS.flatMap((tag) => TAG_SEARCH_WORDS[tag].map((word) => ({ word, tag })));

/**
 * Rebuilds the vocabulary (`search_terms`) from the looks that can be shown:
 * every word (stop words and single letters left out) with how many looks
 * have it, plus the tag words of tags some look has. Writes only what
 * changed. Runs every 15 minutes and after the seed loaders.
 */
export async function refreshSearchTerms(db: Db): Promise<{ changed: number; removed: number }> {
  const { rows } = await db.execute<{ changed: number; removed: number }>(sql`
    WITH words AS (
      SELECT w.lexeme AS term, count(*)::int AS look_count
        FROM looks l, unnest(l.search_vector) AS w
       WHERE ${showableLook(sql`l`)} AND l.published_at <= now()
         AND char_length(w.lexeme) >= 2 AND w.lexeme <> ALL(${textArray([...STOP_WORDS])})
         -- Words, not links, emails, paths or numbers like 1.5 (the parser keeps those whole).
         AND w.lexeme !~ '[./@:_]'
       GROUP BY w.lexeme
    ),
    tag_words AS (
      SELECT t.term, t.lexeme, w.look_count
        FROM unnest(${textArray(TAG_WORDS.map((t) => t.word))},
                    ${textArray(TAG_WORDS.map((t) => t.tag))}) AS t(term, lexeme)
        JOIN words w ON w.term = t.lexeme
    ),
    -- A tag word that is also in a caption stands for its tag (the typed word is searched too).
    fresh AS (
      SELECT term, lexeme, look_count FROM tag_words
      UNION ALL
      SELECT term, term, look_count FROM words WHERE term NOT IN (SELECT term FROM tag_words)
    ),
    changed AS (
      INSERT INTO search_terms (term, lexeme, look_count)
      SELECT term, lexeme, look_count FROM fresh
      ON CONFLICT (term) DO UPDATE
        SET lexeme = excluded.lexeme, look_count = excluded.look_count, updated_at = now()
        WHERE (search_terms.lexeme, search_terms.look_count)
              IS DISTINCT FROM (excluded.lexeme, excluded.look_count)
      RETURNING 1
    ),
    removed AS (
      DELETE FROM search_terms s WHERE NOT EXISTS (SELECT 1 FROM fresh f WHERE f.term = s.term)
      RETURNING 1
    )
    SELECT (SELECT count(*) FROM changed)::int AS changed,
           (SELECT count(*) FROM removed)::int AS removed`);
  return rows[0] ?? { changed: 0, removed: 0 };
}

/**
 * What else each typed word should find, mapped to what looks are searched
 * for (a tag word gives its tag): the word itself if the vocabulary has it,
 * else similar words (a typo, a plural). A known word isn't widened, so
 * "linen" doesn't also find "lined".
 */
async function alternatives(db: Db, words: readonly string[]): Promise<Map<string, string[]>> {
  const { rows } = await db.execute<{ word: string; lexemes: string[] }>(sql`
    SELECT w.word, array_remove(array_agg(s.lexeme), NULL) AS lexemes
      FROM unnest(${textArray(words)}) AS w(word)
      LEFT JOIN LATERAL (
        SELECT s.lexeme FROM search_terms s
         WHERE s.term = w.word
            OR (char_length(w.word) >= ${TYPO_MIN_LENGTH}
                AND NOT EXISTS (SELECT 1 FROM search_terms e WHERE e.term = w.word)
                AND ${similar(sql`s.term`, sql`w.word`)}
                AND ${similarity(sql`s.term`, sql`w.word`)} >= ${TYPO_SIMILARITY})
         ORDER BY s.term = w.word DESC, ${similarity(sql`s.term`, sql`w.word`)} DESC,
                  s.look_count DESC, s.term
         LIMIT ${MAX_ALTERNATIVES}) s ON true
     GROUP BY w.word`);
  return new Map(rows.map((r) => [r.word, r.lexemes]));
}

/** A word as tsquery text: quoted, its quotes and backslashes escaped (never parsed as syntax). */
function quoted(lexeme: string): string {
  return `'${lexeme.replace(/\\/g, '\\\\').replace(/'/g, "''")}'`;
}

/**
 * The tsquery for typed words: every word must match (AND), each as itself
 * or one of its alternatives (OR). The last word also matches as the start
 * of a longer word ("lin" → linen).
 */
export function wordsQuery(
  words: readonly string[],
  alternativesOf: ReadonlyMap<string, readonly string[]>,
): string {
  return words
    .map((word, i) => {
      const prefix = i === words.length - 1 && word.length >= TYPO_MIN_LENGTH;
      const others = new Set(alternativesOf.get(word) ?? []);
      others.delete(word);
      return `(${[quoted(word) + (prefix ? ':*' : ''), ...[...others].map(quoted)].join(' | ')})`;
    })
    .join(' & ');
}

/**
 * The last look of the previous page: its rank, popularity, publish time and
 * id. The rank is a decimal with RANK_DIGITS places, as text: Supabase prints
 * floats with 15 digits, so a float rank read back wouldn't equal itself.
 * Popularity can stay a float because it is stored rounded to 4 decimals
 * (`recomputePopularity`).
 */
const RANK_DIGITS = 6;
const cursorSchema = z.object({
  r: z.string().regex(/^\d{1,3}(\.\d{1,6})?$/),
  p: z.number(),
  t: microsTime,
  id: z.uuid(),
});

interface ResultRow extends Record<string, unknown> {
  id: string;
  /** numeric, as text. */
  rank: string;
  popularity_score: number;
  t: string;
}

/**
 * Looks matching a search, best match first (words in the tags and caption
 * count more than in the AI description), then popular, then newest. 20 per
 * page. Popularity can change between pages, so a look may rarely repeat (the
 * app drops repeats) or be skipped, as in "more like this".
 */
export async function searchLooks(
  deps: FeedDeps,
  viewerProfileId: string | null,
  text: string,
  cursor: string | undefined,
): Promise<FeedPage> {
  const after = cursor === undefined ? undefined : decodeCursor(cursorSchema, cursor);
  const words = searchWords(text);
  if (words.length === 0) return { items: [], nextCursor: null };
  const query = wordsQuery(words, await alternatives(deps.db, words));

  const { rows } = await deps.db.execute<ResultRow>(sql`
    SELECT c.id, c.rank, c.popularity_score, ${microsText(sql`c.published_at`)} AS t
      FROM (SELECT l.id, round(ts_rank(l.search_vector, ${query}::tsquery)::numeric, ${RANK_DIGITS}) AS rank,
                   l.popularity_score, l.published_at
              FROM looks l
             WHERE l.search_vector @@ ${query}::tsquery
               AND ${showableLook(sql`l`)} AND l.published_at <= now()) c
     ${
       after
         ? sql`WHERE (c.rank, c.popularity_score, c.published_at, c.id)
                   < (${after.r}::numeric, ${after.p}::float8, ${after.t}::timestamptz, ${after.id}::uuid)`
         : sql``
     }
     ORDER BY c.rank DESC, c.popularity_score DESC, c.published_at DESC, c.id DESC
     LIMIT ${FEED_PAGE_SIZE + 1}`);

  const page = rows.slice(0, FEED_PAGE_SIZE);
  const cards = await loadCards(
    deps,
    page.map((r) => r.id),
    viewerProfileId,
  );
  const last = page.at(-1);
  return {
    // A look hidden between the two queries is left out of this page.
    items: page.flatMap((r) => cards.get(r.id) ?? []),
    nextCursor:
      rows.length > FEED_PAGE_SIZE && last
        ? encodeCursor({ r: last.rank, p: last.popularity_score, t: last.t, id: last.id })
        : null,
  };
}

/** Vocabulary words that complete `word` (or, from 3 letters, look like a typo of it). */
async function completions(db: Db, word: string): Promise<string[]> {
  const prefix = likePrefix(word);
  const typo =
    word.length >= TYPO_MIN_LENGTH
      ? sql`OR (${similar(sql`s.term`, sql`${word}::text`)}
               AND ${similarity(sql`s.term`, sql`${word}::text`)} >= ${TYPO_SIMILARITY})`
      : sql``;
  const { rows } = await db.execute<{ term: string }>(sql`
    SELECT s.term FROM search_terms s
     WHERE s.term LIKE ${prefix} ${typo}
     ORDER BY s.term LIKE ${prefix} DESC, s.look_count DESC, s.term
     LIMIT ${MAX_SUGGESTED_TERMS}`);
  return rows.map((r) => r.term);
}

/** People who post, by handle (start, or similar from 3 letters) or a name containing the text. */
async function people({ db, storage }: FeedDeps, text: string) {
  const handle = text.trim().toLowerCase().replace(/^@/, '');
  if (handle.length < 2) return [];
  const prefix = likePrefix(handle);
  const typo =
    handle.length >= TYPO_MIN_LENGTH
      ? sql`OR ${similar(sql`p.handle`, sql`${handle}::text`)}`
      : sql``;
  const { rows } = await db.execute<BriefRow>(sql`
    SELECT ${briefColumns}
      FROM profiles p ${avatarJoin}
     WHERE p.deleted_at IS NULL
       AND (p.handle LIKE ${prefix} OR lower(p.display_name) LIKE ${`%${prefix}`} ${typo})
       AND EXISTS (SELECT 1 FROM looks l WHERE ${profileLook(sql`p.id`)})
     ORDER BY p.handle LIKE ${prefix} DESC,
              ${similarity(sql`p.handle`, sql`${handle}::text`)} DESC, p.handle
     LIMIT ${MAX_SUGGESTED_PROFILES}`);
  return rows.map((row) => toBrief(storage, row));
}

/**
 * Suggestions while typing: the search with its last word completed from
 * the vocabulary (earlier words kept), most common first, and people.
 */
export async function suggest(deps: FeedDeps, text: string): Promise<Suggestions> {
  const words = searchWords(text);
  const last = words.at(-1);
  const before = words.slice(0, -1);
  const [terms, profiles] = await Promise.all([
    last ? completions(deps.db, last) : Promise.resolve([]),
    people(deps, text),
  ]);
  return {
    terms: [...new Set(terms.map((term) => [...before, term].join(' ')))],
    profiles,
  };
}

const TAGS = new Set<string>(LOOK_TAGS);

/** The tags most looks carry (from the vocabulary), most first. */
export async function popularTags(db: Db): Promise<PopularTags> {
  const { rows } = await db.execute<{ term: string }>(sql`
    SELECT term FROM search_terms WHERE term = ANY(${textArray(LOOK_TAGS)})
     ORDER BY look_count DESC, term
     LIMIT ${MAX_POPULAR_TAGS}`);
  return { tags: rows.flatMap((r) => (TAGS.has(r.term) ? [r.term as LookTag] : [])) };
}
