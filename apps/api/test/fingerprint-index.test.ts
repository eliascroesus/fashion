// The HNSW fingerprint index on realistic fingerprints: clusters of dense vectors, like photos of
// outfits (the ranking tests use axis-aligned ones and no index; see vectors.ts).
import { createDb, sql } from '@outfitly/db';
import { FINGERPRINT_DIMENSIONS } from '@outfitly/shared';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { rankSimilarLooks } from '../src/similar-looks.ts';
import { createAuthor, createLooks, seeded } from './feed-fixtures.ts';
import { createTestContext, type TestContext } from './helpers.ts';
import { vectorText } from './vectors.ts';

const MODEL = 'Marqo/marqo-fashionSigLIP@c56244c';
const LOOKS = 400;

let ctx: TestContext;
let ids: string[];
const vectors = new Map<string, number[]>();

const random = seeded(38);
function gaussian(): number {
  const u = Math.max(random(), 1e-9);
  return Math.sqrt(-2 * Math.log(u)) * Math.cos(2 * Math.PI * random());
}
function normalised(v: number[]): number[] {
  const length = Math.hypot(...v);
  return v.map((x) => x / length);
}
const dense = () => normalised(Array.from({ length: FINGERPRINT_DIMENSIONS }, gaussian));
const cosine = (a: number[], b: number[]) => a.reduce((sum, x, i) => sum + x * (b[i] ?? 0), 0);

beforeAll(async () => {
  ctx = await createTestContext();
  const authors = await Promise.all(
    Array.from({ length: 20 }, (_, i) => createAuthor(ctx.db, `index.${String(i)}`)),
  );
  ids = await createLooks(
    ctx.db,
    Array.from({ length: LOOKS }, (_, i) => ({ authorId: authors[i % authors.length] ?? '' })),
  );
  // 12 styles; each look is near its style, with its own differences.
  const centres = Array.from({ length: 12 }, dense);
  for (const [i, id] of ids.entries()) {
    const centre = centres[i % centres.length] ?? [];
    const noise = dense();
    vectors.set(id, normalised(centre.map((x, k) => x + 0.6 * (noise[k] ?? 0))));
  }
  for (const id of ids) {
    await ctx.db.execute(sql`
      UPDATE media SET embedding = ${vectorText(vectors.get(id) ?? [])}::extensions.halfvec,
                       embedding_model = ${MODEL}
       WHERE id = (SELECT media_id FROM look_media WHERE look_id = ${id} AND position = 0)`);
  }
  await ctx.db.execute(sql`ANALYZE media`);
});

afterAll(async () => {
  await ctx.close();
});

describe('the fingerprint index', () => {
  it('finds the truly nearest looks through HNSW, and leaves no search setting behind', async () => {
    // Sequential scans off: Postgres has to use the index (the path a big catalogue takes).
    const url = new URL(ctx.testDb.url);
    url.searchParams.set('options', '-c enable_seqscan=off');
    const indexOnly = createDb(url.toString());
    try {
      const { rows } = await indexOnly.execute<Record<string, string>>(sql`
        EXPLAIN SELECT id FROM media WHERE embedding IS NOT NULL
         ORDER BY embedding OPERATOR(extensions.<=>) ${vectorText(dense())}::extensions.halfvec
         LIMIT 5`);
      expect(rows.map((r) => Object.values(r)[0]).join('\n')).toContain('media_embedding_idx');

      for (const base of ids.slice(0, 10)) {
        const own = vectors.get(base) ?? [];
        const exact = ids
          .filter((id) => id !== base)
          .map((id) => ({ id, similarity: cosine(own, vectors.get(id) ?? []) }))
          .sort((a, b) => b.similarity - a.similarity)
          .slice(0, 20)
          .map((x) => x.id);
        const { lookIds } = await rankSimilarLooks(indexOnly, null, base);
        // Recall: the true 20 nearest are (nearly all) on the first page or just after it.
        const found = exact.filter((id) => lookIds.slice(0, 25).includes(id));
        expect(found.length, `look ${base}`).toBeGreaterThanOrEqual(18);
      }
    } finally {
      await indexOnly.$client.end();
    }
    // The wider search settings lasted only for their transaction.
    await rankSimilarLooks(ctx.db, null, ids[0] ?? '');
    for (let i = 0; i < 5; i++) {
      const { rows } = await ctx.db.execute<{ setting: string | null }>(
        sql`SELECT current_setting('hnsw.iterative_scan', true) AS setting`,
      );
      expect(rows[0]?.setting ?? 'off').toBe('off');
    }
  });
});
