import { eq, lookLists, sql } from '@outfitly/db';
import { type FeedPage, feedPageSchema } from '@outfitly/shared';
import type { FastifyInstance } from 'fastify';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { EmbedderClient } from '../src/ai/embedder.ts';
import { WordFingerprints } from '../src/ai/word-fingerprints.ts';
import { buildApp } from '../src/app.ts';
import { fuseRankings, refreshSearchTerms } from '../src/search.ts';
import { json } from './ai-fakes.ts';
import { createAuthor, createLook } from './feed-fixtures.ts';
import { createTestContext, type TestContext, testConfig, testJwks } from './helpers.ts';
import { angled, vectorText, dropFingerprintIndexes } from './vectors.ts';

const MODEL = 'Marqo/marqo-fashionSigLIP@c56244c';

/** What the fingerprint service does next: answer, fail, or hang until the caller gives up. */
let service: 'up' | 'down' | 'hang' = 'up';
let textCalls: string[] = [];

/** Words' fingerprints: "beige trench" points along axis 0, everything else along axis 5. */
const fakeFetch = ((_input: string | URL | Request, init?: RequestInit) => {
  const { text } = JSON.parse(typeof init?.body === 'string' ? init.body : '{}') as {
    text: string;
  };
  textCalls.push(text);
  if (service === 'down') return Promise.resolve(json({ error: 'starting' }, 503));
  if (service === 'hang') {
    return new Promise<Response>((_resolve, reject) => {
      init?.signal?.addEventListener('abort', () => {
        reject(init.signal?.reason as Error);
      });
    });
  }
  const embedding = text === 'beige trench' ? angled(0, 0, 1) : angled(0, 5, 6);
  return Promise.resolve(json({ model: MODEL, embedding, timing: { inferenceMs: 1 } }));
}) as typeof fetch;

let ctx: TestContext;
let app: FastifyInstance;
const ids: Record<string, string> = {};

async function fingerprintCover(lookId: string, vector: number[]): Promise<void> {
  await ctx.db.execute(sql`
    UPDATE media SET embedding = ${vectorText(vector)}::extensions.halfvec, embedding_model = ${MODEL}
     WHERE id = (SELECT media_id FROM look_media WHERE look_id = ${lookId} AND position = 0)`);
}

beforeAll(async () => {
  ctx = await createTestContext();
  await dropFingerprintIndexes(ctx.db);
  const embedder = new EmbedderClient({
    url: 'https://embedder.test',
    secret: 'x'.repeat(32),
    fetch: fakeFetch,
  });
  app = await buildApp({
    config: testConfig(ctx.testDb.url),
    db: ctx.db,
    jwks: testJwks,
    storage: ctx.storage,
    queue: ctx.queue,
    logger: false,
    words: new WordFingerprints(embedder, { timeoutMs: 100 }),
  });
  await app.ready();
  const author = await createAuthor(ctx.db, 'words.author');
  ids['captioned'] = await createLook(ctx.db, {
    authorId: author,
    caption: 'Beige trench over jeans',
  });
  ids['lookalike'] = await createLook(ctx.db, { authorId: author, caption: 'My Sunday' });
  ids['unlike'] = await createLook(ctx.db, { authorId: author, caption: 'Lazy day' });
  ids['hidden'] = await createLook(ctx.db, { authorId: author, status: 'hidden' });
  await fingerprintCover(ids['captioned'], angled(30, 0, 1));
  await fingerprintCover(ids['lookalike'], angled(10, 0, 1));
  // Cosine 0.02: under the floor, so not "found" by its looks.
  await fingerprintCover(ids['unlike'], angled(88.85, 0, 1));
  await fingerprintCover(ids['hidden'], angled(1, 0, 1));
  await refreshSearchTerms(ctx.db);
});

afterAll(async () => {
  await app.close();
  await ctx.close();
});

async function search(q: string, cursor?: string): Promise<FeedPage> {
  const params = new URLSearchParams({ q, ...(cursor ? { cursor } : {}) });
  const res = await app.inject({ method: 'GET', url: `/v1/search/looks?${params.toString()}` });
  expect(res.statusCode, res.body).toBe(200);
  return feedPageSchema.parse(res.json());
}

const listsFor = (key: string) =>
  ctx.db.select({ complete: lookLists.complete }).from(lookLists).where(eq(lookLists.key, key));

describe('search by words and by how the words look', () => {
  it('also finds looks that look like the words, without them in the caption', async () => {
    service = 'up';
    textCalls = [];
    const { items } = await search('beige trench');
    // Found by both comes first, then found by its looks only. Never hidden or unlike ones.
    expect(items.map((c) => c.id)).toEqual([ids['captioned'], ids['lookalike']]);
    expect(textCalls).toEqual(['beige trench']);
    expect(await listsFor('beige trench')).toEqual([{ complete: true }]);
    // Again (another visitor): the same list, no new fingerprint asked for.
    expect((await search('beige trench')).items.map((c) => c.id)).toEqual(items.map((c) => c.id));
    expect(textCalls).toHaveLength(1);
  });

  it('goes on with words alone when the fingerprint service is down or too slow', async () => {
    for (const state of ['down', 'hang'] as const) {
      service = state;
      const key = state === 'down' ? 'beige jeans' : 'trench jeans';
      const started = performance.now();
      const { items } = await search(key);
      expect(performance.now() - started).toBeLessThan(2000);
      expect(items.map((c) => c.id)).toEqual([ids['captioned']]);
      // Not reused: the next search for these words asks the service again.
      expect(await listsFor(key)).toEqual([{ complete: false }]);
    }
    service = 'up';
    textCalls = [];
    await search('trench jeans');
    expect(textCalls).toEqual(['trench jeans']);
    expect(await listsFor('trench jeans')).toHaveLength(2);
  });
});

describe('fuseRankings', () => {
  it('puts looks high in both lists first, then by best place, then the earlier list', () => {
    const lists = (a: string[], b: string[]) => [
      { ids: a, weight: 1 },
      { ids: b, weight: 1 },
    ];
    expect(fuseRankings(lists(['a', 'b', 'c'], ['c', 'd']))).toEqual(['c', 'a', 'b', 'd']);
    expect(fuseRankings(lists([], ['x']))).toEqual(['x']);
  });

  it('lets matching words outweigh fingerprint guesses (words count double)', () => {
    const words = Array.from({ length: 70 }, (_, i) => `w${String(i)}`);
    const fused = fuseRankings([
      { ids: words, weight: 1 },
      { ids: ['f0', 'w69'], weight: 0.5 },
    ]);
    // A look found by its looks alone comes after ~60 word matches (0.5/61 ≈ 1/122).
    expect(fused.indexOf('f0')).toBeGreaterThan(55);
    // Found by both still climbs.
    expect(fused.indexOf('w69')).toBeLessThan(fused.indexOf('w68'));
  });
});

describe('WordFingerprints', () => {
  it('remembers recent fingerprints (least recently used go first) and never throws', async () => {
    service = 'up';
    textCalls = [];
    const errors: unknown[] = [];
    const words = new WordFingerprints(
      new EmbedderClient({
        url: 'https://embedder.test',
        secret: 'x'.repeat(32),
        fetch: fakeFetch,
      }),
      { cacheSize: 2, timeoutMs: 100, onError: (error) => errors.push(error) },
    );
    await words.get('one');
    await words.get('two');
    await words.get('one');
    await words.get('three'); // "two" was used longest ago: it goes
    await words.get('one');
    await words.get('two');
    expect(textCalls).toEqual(['one', 'two', 'three', 'two']);
    service = 'down';
    expect(await words.get('four')).toBeNull();
    expect(errors).toHaveLength(1);
  });
});
