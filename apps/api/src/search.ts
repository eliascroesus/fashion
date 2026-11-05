import { type Db, type SQL, sql } from '@outfitly/db';
import {
  type FeedPage,
  LOOK_TAGS,
  type LookTag,
  type PopularTags,
  searchWords,
  STOP_WORDS,
  type Suggestions,
  TAG_SEARCH_WORDS,
} from '@outfitly/shared';
import type { WordFingerprint, WordFingerprints } from './ai/word-fingerprints.ts';
import { type FeedDeps, showableLook } from './feed/cards.ts';
import {
  firstListPage,
  LIST_RULES,
  nextListPage,
  recentList,
  saveList,
} from './feed/look-lists.ts';
import { avatarJoin, briefColumns, type BriefRow, profileLook, toBrief } from './profile-page.ts';
import { strictly, widenVectorSearch } from './similar-looks.ts';

/**
 * Possible typos of a typed word: up to this many vocabulary words pg_trgm
 * finds similar (`%`, similarity ≥ 0.3), of which only the closest by letter
 * changes are kept (see `closest`).
 */
const TYPO_CANDIDATES = 20;
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
 * How many letters to add, remove, change, or swap with the next one, to
 * turn `a` into `b` ("jeens" → "jeans" is 1, "minimel" → "mini" is 3).
 */
export function editDistance(a: string, b: string): number {
  const x = Array.from(a);
  const y = Array.from(b);
  const d = Array.from({ length: x.length + 1 }, (_, i) =>
    Array.from({ length: y.length + 1 }, (_, j) => (i === 0 ? j : j === 0 ? i : 0)),
  );
  for (let i = 1; i <= x.length; i++) {
    const row = d[i] ?? [];
    for (let j = 1; j <= y.length; j++) {
      const cost = x[i - 1] === y[j - 1] ? 0 : 1;
      let best = Math.min(
        (d[i - 1]?.[j] ?? 0) + 1,
        (row[j - 1] ?? 0) + 1,
        (d[i - 1]?.[j - 1] ?? 0) + cost,
      );
      if (i > 1 && j > 1 && x[i - 1] === y[j - 2] && x[i - 2] === y[j - 1]) {
        best = Math.min(best, (d[i - 2]?.[j - 2] ?? 0) + 1);
      }
      row[j] = best;
    }
  }
  return d[x.length]?.[y.length] ?? 0;
}

/**
 * The typos of `word` among `candidates` (in the order given): the fewest
 * letter changes away, at most 1 for words of up to 4 letters and 2 for longer
 * ones. So "linnen" gets linen but not "lined", "minimel" minimal but not "mini".
 */
export function closest<T extends { term: string }>(word: string, candidates: readonly T[]): T[] {
  const allowed = Array.from(word).length <= 4 ? 1 : 2;
  const scored = candidates
    .map((candidate) => ({ candidate, edits: editDistance(candidate.term, word) }))
    .filter(({ edits }) => edits <= allowed);
  const fewest = Math.min(...scored.map(({ edits }) => edits));
  return scored.filter(({ edits }) => edits === fewest).map(({ candidate }) => candidate);
}

/** pg_trgm's similar vocabulary words for `word`, most similar first. */
function typoCandidates(word: SQL): SQL {
  return sql`SELECT s.term, s.lexeme FROM search_terms s
              WHERE ${similar(sql`s.term`, word)}
              ORDER BY ${similarity(sql`s.term`, word)} DESC, s.look_count DESC, s.term
              LIMIT ${TYPO_CANDIDATES}`;
}

/**
 * What else each typed word should find, mapped to what looks are searched
 * for (a tag word gives its tag): the word itself if the vocabulary has it,
 * else its closest typos (a misspelling, a plural). A known word isn't
 * widened, so "linen" doesn't also find "lined".
 */
async function alternatives(db: Db, words: readonly string[]): Promise<Map<string, string[]>> {
  const { rows } = await db.execute<{ word: string; term: string; lexeme: string }>(sql`
    SELECT w.word, s.term, s.lexeme
      FROM unnest(${textArray(words)}) AS w(word)
      CROSS JOIN LATERAL (
        SELECT e.term, e.lexeme FROM search_terms e WHERE e.term = w.word
        UNION ALL
        SELECT t.term, t.lexeme FROM (${typoCandidates(sql`w.word`)}) t
         WHERE char_length(w.word) >= ${TYPO_MIN_LENGTH}
           AND NOT EXISTS (SELECT 1 FROM search_terms e WHERE e.term = w.word)) s`);
  const result = new Map<string, string[]>();
  for (const word of words) {
    const found = rows.filter((r) => r.word === word);
    const exact = found.filter((r) => r.term === word);
    const matches = exact.length > 0 ? exact : closest(word, found).slice(0, MAX_ALTERNATIVES);
    result.set(
      word,
      matches.map((r) => r.lexeme),
    );
  }
  return result;
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

export const HYBRID_RULES = {
  /** Looks found by matching words, best first, before the two lists are merged. */
  byWords: LIST_RULES.size,
  /** Looks found by fingerprint, nearest first. */
  byFingerprint: 200,
  /** Nearest photos read from the fingerprint index before the rules filter them. */
  candidates: 600,
  /**
   * A look counts as found by fingerprint when its cover is at least this
   * similar (cosine) to the words' fingerprint. Measured on the 125 seed looks:
   * the true matches of "beige trench", "black leather jacket", "red dress"
   * score 0.05–0.11; nonsense ("asdfgh") stays under 0.03.
   */
  minSimilarity: 0.05,
  /** Reciprocal rank fusion: a look gets 1 / (k + its place) from each list it's in. */
  fusionK: 60,
} as const;

/** What a search needs: the feed's database and photos, and words' fingerprints (null = off). */
export interface SearchDeps extends FeedDeps {
  words?: WordFingerprints | null;
}

/**
 * Looks matching the words, best match first (words in the tags and caption
 * count more than in the AI description), then popular, then newest.
 */
async function byWords(db: Db, words: readonly string[]): Promise<string[]> {
  const query = wordsQuery(words, await alternatives(db, words));
  const { rows } = await db.execute<{ id: string }>(sql`
    SELECT l.id FROM looks l
     WHERE l.search_vector @@ ${query}::tsquery
       AND ${showableLook(sql`l`)} AND l.published_at <= now()
     ORDER BY ts_rank(l.search_vector, ${query}::tsquery) DESC, l.popularity_score DESC,
              l.published_at DESC, l.id DESC
     LIMIT ${HYBRID_RULES.byWords}`);
  return rows.map((r) => r.id);
}

/** Looks whose cover photo looks most like the words (same fingerprint model only). */
async function byFingerprint(db: Db, fingerprint: WordFingerprint): Promise<string[]> {
  const vector = `[${fingerprint.embedding.join(',')}]`;
  return db.transaction(async (tx) => {
    await widenVectorSearch(tx);
    const { rows } = await tx.execute<{ id: string }>(sql`
      WITH near AS MATERIALIZED (
        SELECT m.id, m.embedding <=> ${vector}::extensions.halfvec AS distance
          FROM media m
         WHERE m.embedding_model = ${fingerprint.model} AND m.deleted_at IS NULL
         ORDER BY m.embedding <=> ${vector}::extensions.halfvec
         LIMIT ${HYBRID_RULES.candidates}
      )
      SELECT l.id FROM near
        JOIN look_media lm ON lm.media_id = near.id AND lm.position = 0
        JOIN looks l ON l.id = lm.look_id
       WHERE near.distance <= ${1 - HYBRID_RULES.minSimilarity}
         AND ${showableLook(sql`l`)} AND l.published_at <= now()
       ORDER BY ${strictly(sql`near.distance`)}, l.id
       LIMIT ${HYBRID_RULES.byFingerprint}`);
    return rows.map((r) => r.id);
  });
}

/**
 * Merges ranked lists (reciprocal rank fusion): a look gets 1 / (k + place)
 * from each list it's in, so looks high in both come first and a look high
 * in one still beats one low in both. Ties: the better best place, then the
 * earlier list, then the id.
 */
export function fuseRankings(
  lists: readonly (readonly string[])[],
  k: number = HYBRID_RULES.fusionK,
): string[] {
  const found = new Map<string, { score: number; best: number; list: number }>();
  lists.forEach((list, which) => {
    list.forEach((id, i) => {
      const place = i + 1;
      const entry = found.get(id);
      if (entry) {
        entry.score += 1 / (k + place);
        if (place < entry.best) [entry.best, entry.list] = [place, which];
      } else {
        found.set(id, { score: 1 / (k + place), best: place, list: which });
      }
    });
  });
  return [...found.entries()]
    .sort(
      ([a, x], [b, y]) =>
        y.score - x.score || x.best - y.best || x.list - y.list || (a < b ? -1 : a > b ? 1 : 0),
    )
    .map(([id]) => id);
}

/**
 * A search: looks whose words match (see `byWords`) merged with looks whose
 * cover looks like the words (`byFingerprint`, when the fingerprint service
 * answers in time; else words alone). Up to LIST_RULES.size looks, 20 per
 * page. Page 1 makes the list (or reuses one made for the same words in the
 * last few minutes: search isn't personal), later pages read on from it, so
 * nothing repeats or is skipped.
 */
export async function searchLooks(
  deps: SearchDeps,
  viewerProfileId: string | null,
  text: string,
  cursor: string | undefined,
): Promise<FeedPage> {
  const words = searchWords(text);
  if (words.length === 0) return { items: [], nextCursor: null };
  const key = words.join(' ');
  if (cursor !== undefined) {
    const page = await nextListPage(deps, viewerProfileId, 'search', key, cursor);
    if (page) return page;
  }
  const recent = await recentList(deps.db, 'search', key, null);
  if (recent) return firstListPage(deps, viewerProfileId, recent);

  const [matching, fingerprint] = await Promise.all([
    byWords(deps.db, words),
    deps.words ? deps.words.get(key) : Promise.resolve(null),
  ]);
  const looking = fingerprint ? await byFingerprint(deps.db, fingerprint) : [];
  const lookIds = fuseRankings([matching, looking]).slice(0, LIST_RULES.size);
  if (lookIds.length === 0) return { items: [], nextCursor: null };
  // Without the fingerprint it couldn't get, the list isn't reused: the next search tries again.
  const complete = !deps.words || fingerprint !== null;
  const id = await saveList(deps.db, 'search', key, null, lookIds, complete);
  return firstListPage(deps, viewerProfileId, { id, total: lookIds.length, lookIds });
}

/**
 * Vocabulary words that complete `word`, most common first; only when none
 * does (from 3 letters), its closest typos.
 */
async function completions(db: Db, word: string): Promise<string[]> {
  const { rows } = await db.execute<{ term: string }>(sql`
    SELECT s.term FROM search_terms s
     WHERE s.term LIKE ${likePrefix(word)}
     ORDER BY s.look_count DESC, s.term
     LIMIT ${MAX_SUGGESTED_TERMS}`);
  if (rows.length > 0 || Array.from(word).length < TYPO_MIN_LENGTH) return rows.map((r) => r.term);
  const typos = await db.execute<{ term: string; lexeme: string }>(
    typoCandidates(sql`${word}::text`),
  );
  return closest(word, typos.rows)
    .slice(0, MAX_SUGGESTED_TERMS)
    .map((r) => r.term);
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
