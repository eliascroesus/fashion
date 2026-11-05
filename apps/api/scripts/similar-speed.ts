// Speed check for "More like this" and similar pieces (target: p95 under 300 ms), plus search by
// words + fingerprint. From the repo root:
//   pnpm similar:speed                      logged out, over HTTP against the staging API
//   --url <api base>  (default https://outfitly-api-staging.fly.dev)
//   pnpm similar:speed --direct             the server's own time: runs the code from this computer
//                                           against DATABASE_URL (or --database <url>, e.g. the
//                                           local catalogue from `pnpm similar:speed-data`)
//   --looks N  looks and pieces to try (default 30)
// Each look's "More like this" is a new list the first time (page 1 ranks it), then read from the
// list (page 2, and page 1 again as when going back). Direct runs remove their lists first so page
// 1 is always measured fresh, and time the words' fingerprint (the fingerprint service) apart.
import { createDb, inArray, lookLists, sql } from '@outfitly/db';
import { feedPageSchema, similarPiecesPageSchema } from '@outfitly/shared';
import { photoAiClients } from '../src/ai/clients.ts';
import { WordFingerprints } from '../src/ai/word-fingerprints.ts';
import { loadConfig, r2Config } from '../src/config.ts';
import { searchLooks } from '../src/search.ts';
import { similarPage } from '../src/similar-looks.ts';
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
