import { type Db, type SQL, sql } from '@outfitly/db';
import { type FeedPage, MAX_SIMILAR_LOOKS } from '@outfitly/shared';
import { ApiError } from './errors.ts';
import { applyDiversity, type Candidate, FEED_RULES, similarityKey } from './feed/arrange.ts';
import { type FeedDeps, showableLook } from './feed/cards.ts';
import { firstListPage, nextListPage, recentList, saveList } from './feed/look-lists.ts';

type Tx = Parameters<Parameters<Db['transaction']>[0]>[0];

export const SIMILAR_RULES = {
  /**
   * Nearest covers read from the fingerprint index. The rules are checked
   * during the scan (iterative scan), so these are all allowed ones.
   */
  candidates: MAX_SIMILAR_LOOKS,
  /**
   * How many neighbours the index search keeps in view (pgvector's
   * `hnsw.ef_search`): more finds the true nearest more often, but is slower.
   */
  efSearch: 100,
} as const;

/**
 * A distance to sort on for real. The index hands back neighbours only
 * roughly in order (see widenVectorSearch), but Postgres 17 assumes a
 * materialized CTE's rows come out in its ORDER BY and would skip the final
 * sort; `+ 0` makes it a new value, so it sorts (pgvector's documented fix).
 */
export const strictly = (distance: SQL): SQL => sql`(${distance} + 0)`;

/**
 * Cosine distance between two fingerprints (0 = same direction). pgvector's
 * operator lives in the `extensions` schema; named in full so the
 * search_path never matters (the index is still used).
 */
export const cosineDistance = (a: SQL, b: SQL): SQL => sql`${a} OPERATOR(extensions.<=>) ${b}`;

/**
 * Nearest-fingerprint searches in this transaction: wider than the default
 * (40), and carrying on past the first neighbours when filters leave too
 * few ("iterative scan", pgvector 0.8). `relaxed_order` may hand them back
 * slightly out of order, so callers sort by distance again (`strictly`).
 */
export async function widenVectorSearch(tx: Tx, efSearch: number = SIMILAR_RULES.efSearch) {
  await tx.execute(sql`SELECT set_config('hnsw.ef_search', ${String(efSearch)}, true),
                              set_config('hnsw.iterative_scan', 'relaxed_order', true)`);
}

interface CandidateRow extends Record<string, unknown> {
  id: string;
  author_profile_id: string;
  occasion_tags: string[];
  season_tags: string[];
  /** Seen by the viewer in the last week: goes after every unseen look. */
  seen: boolean;
}

/**
 * Looks anyone (or this viewer) may get in "More like this": shown, not the
 * look itself, not the viewer's own, not marked "see less like this", and
 * nothing the viewer saw in the last day (`FEED_RULES.refillAfterHours`).
 * Looks seen in the last week go after the unseen ones (`seen_recently`).
 */
function allowedFor(viewer: string | null, lookId: string) {
  const v = sql`${viewer}::uuid`;
  return sql`${showableLook(sql`l`)} AND l.published_at <= now() AND l.id <> ${lookId}
    AND l.author_profile_id IS DISTINCT FROM ${v}
    AND l.id NOT IN (SELECT w.look_id FROM swipes w WHERE w.profile_id = ${v} AND w.kind = 'see_less')
    AND l.id NOT IN (SELECT s.look_id FROM seen s WHERE s.profile_id = ${v}
                      AND s.last_seen_at > now() - make_interval(hours => ${FEED_RULES.refillAfterHours}))`;
}

function seenRecently(viewer: string | null): SQL {
  return sql`EXISTS (SELECT 1 FROM seen s WHERE s.profile_id = ${viewer}::uuid AND s.look_id = l.id
                        AND s.last_seen_at > now() - make_interval(days => ${FEED_RULES.seenDays}))`;
}

/**
 * Looks whose cover looks most like this look's cover (cosine distance of the
 * whole-photo fingerprints, same model only), nearest first; seen-this-week
 * ones after the rest. Empty when the look's cover has no fingerprint.
 */
async function visuallyNearest(
  tx: Tx,
  viewer: string | null,
  lookId: string,
): Promise<CandidateRow[]> {
  await widenVectorSearch(tx);
  const { rows } = await tx.execute<CandidateRow>(sql`
    WITH base AS (
      SELECT m.embedding, m.embedding_model FROM look_media lm JOIN media m ON m.id = lm.media_id
       WHERE lm.look_id = ${lookId} AND lm.position = 0 AND m.embedding IS NOT NULL
    ),
    -- The rules are checked inside the index scan, so it carries on past photos they leave out
    -- (not a cover, a hidden look, one the viewer saw today…) until it has enough.
    near AS MATERIALIZED (
      SELECT m.id, ${cosineDistance(sql`m.embedding`, sql`(SELECT embedding FROM base)`)} AS distance
        FROM media m
       WHERE m.embedding_model = (SELECT embedding_model FROM base) AND m.deleted_at IS NULL
         -- A scalar subquery, not EXISTS: checked photo by photo while the index scan walks,
         -- where EXISTS becomes a join over every photo (see showableLook).
         AND (SELECT true FROM look_media lm JOIN looks l ON l.id = lm.look_id
               WHERE lm.media_id = m.id AND lm.position = 0 AND ${allowedFor(viewer, lookId)}
               LIMIT 1)
       ORDER BY ${cosineDistance(sql`m.embedding`, sql`(SELECT embedding FROM base)`)}
       LIMIT ${SIMILAR_RULES.candidates}
    )
    SELECT l.id, l.author_profile_id, l.occasion_tags::text[] AS occasion_tags,
           l.season_tags::text[] AS season_tags, ${seenRecently(viewer)} AS seen
      FROM near
      JOIN look_media lm ON lm.media_id = near.id AND lm.position = 0
      JOIN looks l ON l.id = lm.look_id
     WHERE ${allowedFor(viewer, lookId)}
     ORDER BY ${seenRecently(viewer)}, ${strictly(sql`near.distance`)}, l.id
     LIMIT ${MAX_SIMILAR_LOOKS}`);
  return rows;
}

/**
 * Looks sharing the most occasion and season tags with this one, then the
 * most popular, then the newest: for a look without a fingerprint yet, and to
 * top up a list when too few looks have fingerprints. Seen-this-week ones go
 * after the rest; `except` are left out.
 */
async function byTags(
  db: Db | Tx,
  viewer: string | null,
  lookId: string,
  limit: number,
  except: readonly string[],
): Promise<CandidateRow[]> {
  const left =
    except.length === 0 ? sql`` : sql`AND l.id <> ALL(${`{${except.join(',')}}`}::uuid[])`;
  const { rows } = await db.execute<CandidateRow>(sql`
    WITH base AS (SELECT b.occasion_tags::text[] || b.season_tags::text[] AS tags
                    FROM looks b WHERE b.id = ${lookId})
    SELECT l.id, l.author_profile_id, l.occasion_tags::text[] AS occasion_tags,
           l.season_tags::text[] AS season_tags, ${seenRecently(viewer)} AS seen
      FROM looks l, base
     WHERE ${allowedFor(viewer, lookId)} ${left}
     ORDER BY ${seenRecently(viewer)},
              cardinality(ARRAY(SELECT unnest(l.occasion_tags::text[] || l.season_tags::text[])
                                INTERSECT SELECT unnest(base.tags))) DESC,
              l.popularity_score DESC, l.published_at DESC, l.id DESC
     LIMIT ${limit}`);
  return rows;
}

const toCandidate = (row: CandidateRow): Candidate => ({
  id: row.id,
  authorId: row.author_profile_id,
  similarityKey: similarityKey(row.occasion_tags, row.season_tags),
});

/**
 * Ranks a new "More like this" list for the viewer: the visually nearest
 * looks, topped up by shared tags while it has room (looks without a
 * fingerprint yet), with the diversity rules applied. `complete` is false
 * when the look itself has no fingerprint (tags only).
 */
export async function rankSimilarLooks(
  db: Db,
  viewer: string | null,
  lookId: string,
): Promise<{ lookIds: string[]; complete: boolean }> {
  return db.transaction(async (tx) => {
    const near = await visuallyNearest(tx, viewer, lookId);
    const room = MAX_SIMILAR_LOOKS - near.length;
    const tagged =
      room > 0
        ? await byTags(
            tx,
            viewer,
            lookId,
            room,
            near.map((r) => r.id),
          )
        : [];
    // Unseen first (nearest, then by tags), then the ones seen this week in the same order.
    const both = [...near, ...tagged];
    const ordered = [...both.filter((r) => !r.seen), ...both.filter((r) => r.seen)];
    const ranked = applyDiversity(ordered.map(toCandidate), MAX_SIMILAR_LOOKS);
    return { lookIds: ranked.map((c) => c.id), complete: near.length > 0 };
  });
}

const notFound = () => new ApiError(404, 'not_found', 'Look not found.');

/**
 * "More like this": looks that look most like this one (their cover photos'
 * fingerprints), never the look itself, the viewer's own, ones they marked
 * "see less like this" or saw in the last day; ones seen this week come
 * after the rest. Diversity rules as in For You. Page 1 ranks up to
 * MAX_SIMILAR_LOOKS and saves the list (logged-out visitors share one per
 * look for a while), later pages read on from it, so nothing repeats or is
 * skipped. A look without a fingerprint yet gets looks sharing its tags.
 */
export async function similarPage(
  deps: FeedDeps,
  viewerProfileId: string | null,
  lookId: string,
  cursor: string | undefined,
): Promise<FeedPage> {
  const { rows: base } = await deps.db.execute(sql`
    SELECT 1 FROM looks l
     WHERE l.id = ${lookId} AND ${showableLook(sql`l`)} AND l.published_at <= now()`);
  if (base.length === 0) throw notFound();
  if (cursor !== undefined) {
    const page = await nextListPage(deps, viewerProfileId, 'similar', lookId, cursor);
    if (page) return page;
  }
  const recent = await recentList(deps.db, 'similar', lookId, viewerProfileId);
  if (recent) return firstListPage(deps, viewerProfileId, recent);
  const { lookIds, complete } = await rankSimilarLooks(deps.db, viewerProfileId, lookId);
  if (lookIds.length === 0) return { items: [], nextCursor: null };
  const id = await saveList(deps.db, 'similar', lookId, viewerProfileId, lookIds, complete);
  return firstListPage(deps, viewerProfileId, { id, total: lookIds.length, lookIds });
}
