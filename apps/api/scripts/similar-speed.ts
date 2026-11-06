// Speed check for "More like this" and similar pieces (target: p95 under 300 ms), plus search by
// words + fingerprint. From the repo root:
//   pnpm similar:speed                      logged out, over HTTP against the staging API
//   --url <api base>  (default https://outfitly-api-staging.fly.dev)
//   pnpm similar:speed --direct             the server's own time: runs the code from this computer
//                                           against DATABASE_URL (or --database <url>, e.g. the
//                                           local catalogue from `pnpm similar:speed-data`)
//   --looks N  looks and pieces to try (default 30)
// Each look's "More like this" is a new list the first time (page 1 ranks it), then read from the
// list (page 2, and page 1 again as when going back); logged in too when the database has the
// @speed.viewer that `pnpm similar:speed-data` makes (a week of seen looks, saved lists). Direct runs remove their lists first so page
// 1 is always measured fresh, and time the words' fingerprint (the fingerprint service) apart.
import { createDb, inArray, lookLists, sql } from '@outfitly/db';
import { feedPageSchema, similarPiecesPageSchema } from '@outfitly/shared';
import { photoAiClients } from '../src/ai/clients.ts';
import { WordFingerprints } from '../src/ai/word-fingerprints.ts';
import { loadConfig, r2Config } from '../src/config.ts';
import { searchLooks } from '../src/search.ts';
import { rankSimilarLooks, similarPage } from '../src/similar-looks.ts';
import { similarPiecesPage } from '../src/similar-pieces.ts';
import { R2Storage } from '../src/storage.ts';

const args = process.argv.slice(2);
const option = (name: string) => (args.includes(name) ? args[args.indexOf(name) + 1] : undefined);
const direct = args.includes('--direct');
const count = Number(option('--looks') ?? 30);
const baseUrl = option('--url') ?? 'https://outfitly-api-staging.fly.dev';
const SEARCHES = [
  'beige trench',
  'black leather jacket',
  'red dress',
  'white sneakers',
  'denim skirt',
  'linen trousers',
  'striped shirt',
  'party outfit',
];

const samples = new Map<string, number[]>();
function add(label: string, ms: number): void {
  samples.set(label, [...(samples.get(label) ?? []), ms]);
}
function report(): void {
  for (const [label, values] of samples) {
    const sorted = [...values].sort((a, b) => a - b);
    const at = (p: number) => sorted[Math.min(sorted.length - 1, Math.ceil(p * sorted.length) - 1)];
    const ms = (v: number | undefined) => `${String(Math.round(v ?? 0))} ms`;
    console.log(
      `${label.padEnd(34)} p50 ${ms(at(0.5))} · p95 ${ms(at(0.95))} · max ${ms(sorted.at(-1))} (${String(sorted.length)})`,
    );
  }
}
async function time<T>(label: string, work: () => Promise<T>): Promise<T> {
  const started = performance.now();
  const result = await work();
  add(label, performance.now() - started);
  return result;
}

const config = loadConfig();
const databaseHost = new URL(option('--database') ?? config.DATABASE_URL).host;
const db = createDb(option('--database') ?? config.DATABASE_URL, {
  caCert: option('--database') ? undefined : config.DATABASE_CA_CERT,
});
try {
  const { rows: picked } = await db.execute<{ id: string }>(sql`
    SELECT l.id FROM looks l JOIN look_media lm ON lm.look_id = l.id AND lm.position = 0
      JOIN media m ON m.id = lm.media_id
     WHERE l.status = 'published' AND l.deleted_at IS NULL AND m.embedding IS NOT NULL
     ORDER BY md5(l.id::text) LIMIT ${count}`);
  const { rows: pieces } = await db.execute<{ id: string }>(sql`
    SELECT li.id FROM look_items li JOIN looks l ON l.id = li.look_id
     WHERE li.status = 'verified' AND li.deleted_at IS NULL AND l.status = 'published'
     ORDER BY md5(li.id::text) LIMIT ${count}`);
  const lookIds = picked.map((r) => r.id);
  const itemIds = pieces.map((r) => r.id);
  console.log(`${String(lookIds.length)} looks, ${String(itemIds.length)} pieces.`);

  if (direct) {
    const deps = { db, storage: new R2Storage(r2Config(config)) };
    const ai = photoAiClients(config);
    const words = ai.embedder ? new WordFingerprints(ai.embedder) : null;
    await db.delete(lookLists).where(inArray(lookLists.key, [...lookIds, ...SEARCHES]));
    // Warm the connection pool and the planner.
    await similarPage(deps, null, lookIds[0] ?? '', undefined);
    await db.delete(lookLists).where(inArray(lookLists.key, lookIds));
    for (const lookId of lookIds) {
      const first = await time('More like this, new list', () =>
        similarPage(deps, null, lookId, undefined),
      );
      if (first.nextCursor) {
        const cursor = first.nextCursor;
        await time('More like this, next page', () => similarPage(deps, null, lookId, cursor));
      }
      await time('More like this, page 1 again', () => similarPage(deps, null, lookId, undefined));
    }
    // Recall: how many of each look's true 20 nearest (exact distances, no index) the index-based
    // list puts on page 1. The list also applies the diversity rules, which may move a few.
    const recall: number[] = [];
    for (const lookId of lookIds) {
      const exact = await db.transaction(async (tx) => {
        await tx.execute(sql`SET LOCAL enable_indexscan = off`);
        const { rows } = await tx.execute<{ id: string }>(sql`
          SELECT l.id FROM looks l JOIN look_media lm ON lm.look_id = l.id AND lm.position = 0
            JOIN media m ON m.id = lm.media_id,
                 (SELECT m2.embedding FROM look_media lm2 JOIN media m2 ON m2.id = lm2.media_id
                   WHERE lm2.look_id = ${lookId} AND lm2.position = 0) b
           WHERE l.id <> ${lookId} AND l.status = 'published' AND l.deleted_at IS NULL
             AND m.embedding IS NOT NULL
           ORDER BY m.embedding OPERATOR(extensions.<=>) b.embedding, l.id
           LIMIT 20`);
        return rows.map((r) => r.id);
      });
      const { lookIds: listed } = await rankSimilarLooks(db, null, lookId);
      const first = new Set(listed.slice(0, 20));
      recall.push(exact.filter((id) => first.has(id)).length / Math.max(1, exact.length));
    }
    const average = recall.reduce((sum, r) => sum + r, 0) / Math.max(1, recall.length);
    console.log(
      `Recall: page 1 holds ${(average * 100).toFixed(1)}% of the true 20 nearest on average (lowest ${(Math.min(...recall) * 100).toFixed(0)}%).`,
    );

    // Logged in: the viewer `pnpm similar:speed-data` makes (a week of seen looks, saved lists).
    const { rows: viewers } = await db.execute<{ id: string }>(
      sql`SELECT id FROM profiles WHERE handle = 'speed.viewer'`,
    );
    const viewer = viewers[0]?.id;
    if (viewer) {
      await db.execute(sql`DELETE FROM look_lists WHERE profile_id = ${viewer}
                            AND key = ANY(${`{${lookIds.join(',')}}`}::text[])`);
      for (const lookId of lookIds) {
        const first = await time('More like this, logged in, new list', () =>
          similarPage(deps, viewer, lookId, undefined),
        );
        if (first.nextCursor) {
          const cursor = first.nextCursor;
          await time('More like this, logged in, next page', () =>
            similarPage(deps, viewer, lookId, cursor),
          );
        }
      }
    }
    for (const itemId of itemIds) {
      const first = await time('Similar pieces, nearest', () =>
        similarPiecesPage(deps, itemId, 'nearest', undefined),
      );
      if (first.nextCursor) {
        const cursor = first.nextCursor;
        await time('Similar pieces, next page', () =>
          similarPiecesPage(deps, itemId, 'nearest', cursor),
        );
      }
      await time('Similar pieces, cheaper', () =>
        similarPiecesPage(deps, itemId, 'cheaper', undefined),
      );
    }
    if (words) {
      for (const text of SEARCHES)
        await time("Words' fingerprint (service)", () => words.get(text));
    } else {
      console.log('No EMBEDDER_URL / EMBEDDER_SECRET: search runs by words alone.');
    }
    for (const text of SEARCHES) {
      await db.delete(lookLists).where(inArray(lookLists.key, [text]));
      const first = await time('Search, new list (fingerprint cached)', () =>
        searchLooks({ ...deps, words }, null, text, undefined),
      );
      if (first.nextCursor) {
        const cursor = first.nextCursor;
        await time('Search, next page', () => searchLooks({ ...deps, words }, null, text, cursor));
      }
    }
    console.log(`Server's own time, from this computer to the database at ${databaseHost}:`);
  } else {
    const get = async (path: string) => {
      const res = await fetch(new URL(path, baseUrl));
      const body: unknown = await res.json();
      if (!res.ok) throw new Error(`${path} → ${String(res.status)} ${JSON.stringify(body)}`);
      return body;
    };
    await get('/v1/health');
    for (const lookId of lookIds) {
      await time('Health (network)', () => get('/v1/health'));
      const first = feedPageSchema.parse(
        await time('More like this, page 1', () => get(`/v1/looks/${lookId}/similar`)),
      );
      if (first.nextCursor) {
        const cursor = encodeURIComponent(first.nextCursor);
        await time('More like this, next page', () =>
          get(`/v1/looks/${lookId}/similar?cursor=${cursor}`),
        );
      }
    }
    for (const itemId of itemIds) {
      const first = similarPiecesPageSchema.parse(
        await time('Similar pieces, nearest', () => get(`/v1/look-items/${itemId}/similar`)),
      );
      if (first.nextCursor) {
        const cursor = encodeURIComponent(first.nextCursor);
        await time('Similar pieces, next page', () =>
          get(`/v1/look-items/${itemId}/similar?cursor=${cursor}`),
        );
      }
      await time('Similar pieces, cheaper', () =>
        get(`/v1/look-items/${itemId}/similar?sort=cheaper`),
      );
    }
    for (const text of SEARCHES) {
      await time('Search, page 1', () => get(`/v1/search/looks?q=${encodeURIComponent(text)}`));
    }
    console.log(`Logged out, over HTTP from this computer to ${baseUrl}:`);
  }
  report();
} finally {
  await db.$client.end();
}
