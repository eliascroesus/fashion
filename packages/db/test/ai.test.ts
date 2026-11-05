import { FINGERPRINT_DIMENSIONS } from '@outfitly/shared';
import { cosineDistance, eq, sql } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { Db } from '../src/client.ts';
import { runMigrations } from '../src/migrate.ts';
import { aiCalls, looks, media, moderationQueue } from '../src/schema/index.ts';
import { SEED_PROFILE_IDS, seed } from '../src/seed.ts';
import { createTestDatabase, type TestDatabase, withDb } from './test-database.ts';

let testDb: TestDatabase;

beforeAll(async () => {
  testDb = await createTestDatabase();
  await runMigrations(testDb.url);
  await withDb(testDb.url, seed);
});

afterAll(async () => {
  await testDb.drop();
});

let photoCount = 0;
async function photo(db: Db, values: Partial<typeof media.$inferInsert> = {}): Promise<string> {
  photoCount += 1;
  const [row] = await db
    .insert(media)
    .values({
      ownerProfileId: SEED_PROFILE_IDS.creator,
      originalKey: `originals/ai-test-${String(photoCount)}`,
      ...values,
    })
    .returning({ id: media.id });
  if (!row) throw new Error('media insert returned no row');
  return row.id;
}

function fingerprint(axis: number): number[] {
  const v = new Array<number>(FINGERPRINT_DIMENSIONS).fill(0);
  v[axis] = 1;
  return v;
}

describe('garment spotting tables (Step 3.3)', () => {
  it('search finds a look by its AI search words and description', async () => {
    await withDb(testDb.url, async (db) => {
      const slug = `look-${crypto.randomUUID()}`;
      await db.insert(looks).values({
        authorProfileId: SEED_PROFILE_IDS.creator,
        slug,
        caption: 'Sunday',
        aiDescription: 'A camel coat over a grey knit.',
        aiTags: ['trench', 'minimal'],
      });
      const { rows } = await db.execute<{ words: string }>(
        sql`SELECT search_vector::text AS words FROM looks WHERE slug = ${slug}`,
      );
      // Caption and tags weigh A; the AI's words weigh B.
      expect(rows[0]?.words).toContain(`'sunday':1A`);
      expect(rows[0]?.words).toContain(`'trench':`);
      expect(rows[0]?.words).toContain(`'camel':`);
      expect(rows[0]?.words).toMatch(/'minimal':\d+B/);

      await db
        .update(looks)
        .set({ aiTags: ['beige'] })
        .where(eq(looks.slug, slug));
      const after = await db.execute<{ hit: boolean }>(
        sql`SELECT search_vector @@ to_tsquery('simple', 'beige') AS hit FROM looks WHERE slug = ${slug}`,
      );
      expect(after.rows[0]?.hit).toBe(true);
    });
  });

  it('keep one look_search_vector (the 0009 one is gone)', async () => {
    await withDb(testDb.url, async (db) => {
      const { rows } = await db.execute<{ args: string }>(
        sql`SELECT pg_get_function_identity_arguments(oid) AS args FROM pg_proc WHERE proname = 'look_search_vector'`,
      );
      expect(rows).toHaveLength(1);
      expect(rows[0]?.args).toContain('ai_tags text[]');
    });
  });

  it('find the nearest whole photos through the HNSW index', async () => {
    await withDb(testDb.url, async (db) => {
      const near = await photo(db, { embedding: fingerprint(0), embeddingModel: 'test' });
      await photo(db, { embedding: fingerprint(1), embeddingModel: 'test' });
      const rows = await db
        .select({ id: media.id })
        .from(media)
        .where(sql`${media.embedding} is not null`)
        .orderBy(cosineDistance(media.embedding, fingerprint(0)))
        .limit(1);
      expect(rows[0]?.id).toBe(near);

      await db.transaction(async (tx) => {
        await tx.execute(sql`SET LOCAL enable_seqscan = off`);
        const { rows: plan } = await tx.execute<{ 'QUERY PLAN': string }>(
          sql`EXPLAIN SELECT id FROM media ORDER BY embedding <=> ${JSON.stringify(fingerprint(0))}::extensions.halfvec LIMIT 5`,
        );
        expect(plan.map((r) => r['QUERY PLAN']).join('\n')).toContain('media_embedding_idx');
      });
    });
  });

  it('keep one open review item per flagged photo', async () => {
    await withDb(testDb.url, async (db) => {
      const mediaId = await photo(db);
      await db
        .insert(moderationQueue)
        .values({ kind: 'photo_flagged', mediaId, reasons: ['nudity'] });
      await expect(
        db
          .insert(moderationQueue)
          .values({ kind: 'photo_flagged', mediaId, reasons: ['violence'] }),
      ).rejects.toMatchObject({
        cause: { code: '23505', constraint: 'moderation_queue_open_media_key' },
      });
      // Once resolved, a new flag can open a new item.
      await db
        .update(moderationQueue)
        .set({ status: 'approved', resolvedAt: new Date() })
        .where(eq(moderationQueue.mediaId, mediaId));
      await db
        .insert(moderationQueue)
        .values({ kind: 'photo_flagged', mediaId, reasons: ['blocked'] });

      await expect(
        db
          .insert(moderationQueue)
          .values({ kind: 'photo_flagged', mediaId: null, status: 'removed' }),
      ).rejects.toMatchObject({
        cause: { code: '23514', constraint: 'moderation_queue_resolved_has_time' },
      });
    });
  });

  it('log AI calls with counts that are never negative', async () => {
    await withDb(testDb.url, async (db) => {
      await db.insert(aiCalls).values({
        purpose: 'spot_garments',
        model: 'gemini-3.1-flash-lite',
        promptVersion: 'spot-v1',
        status: 'ok',
        inputTokens: 1500,
        outputTokens: 400,
        costMicros: 975,
        durationMs: 2100,
      });
      await expect(
        db.insert(aiCalls).values({
          purpose: 'spot_garments',
          model: 'm',
          promptVersion: 'p',
          status: 'ok',
          costMicros: -1,
          durationMs: 1,
        }),
      ).rejects.toMatchObject({
        cause: { code: '23514', constraint: 'ai_calls_counts_not_negative' },
      });
    });
  });
});
