import { eq, sql } from 'drizzle-orm';
import pg from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { runMigrations } from '../src/migrate.ts';
import { featureFlags, media, profileMembers, profiles } from '../src/schema/index.ts';
import { SEED_PROFILE_IDS, seed } from '../src/seed.ts';
import { createTestDatabase, type TestDatabase, withDb } from './test-database.ts';

let testDb: TestDatabase;

/** Creates a Supabase login (auth.users row) and returns its id. */
async function createAuthUser(): Promise<string> {
  const client = new pg.Client({ connectionString: testDb.url });
  await client.connect();
  try {
    const { rows } = await client.query<{ id: string }>(
      'INSERT INTO auth.users DEFAULT VALUES RETURNING id',
    );
    const row = rows[0];
    if (!row) throw new Error('auth.users insert returned no row');
    return row.id;
  } finally {
    await client.end();
  }
}

beforeAll(async () => {
  testDb = await createTestDatabase();
  await runMigrations(testDb.url);
});

afterAll(async () => {
  await testDb.drop();
});

describe('seed', () => {
  it('loads test data and can run twice without duplicates', async () => {
    await withDb(testDb.url, seed);
    await withDb(testDb.url, seed);
    await withDb(testDb.url, async (db) => {
      expect(await db.$count(profiles)).toBe(3);
      expect(await db.$count(featureFlags)).toBe(1);
    });
  });
});

describe('profiles', () => {
  it('rejects handles that are not lowercase letters, digits, dots or underscores', async () => {
    await withDb(testDb.url, async (db) => {
      for (const handle of ['Has Space', 'UPPER', 'ab', 'x'.repeat(31), 'emoji😀']) {
        await expect(db.insert(profiles).values({ handle }), handle).rejects.toMatchObject({
          cause: { code: '23514' },
        });
      }
    });
  });

  it('keeps handles unique', async () => {
    await withDb(testDb.url, async (db) => {
      await db.insert(profiles).values({ handle: 'unique.handle' });
      await expect(db.insert(profiles).values({ handle: 'unique.handle' })).rejects.toMatchObject({
        cause: { code: '23505' },
      });
    });
  });

  it('bumps updated_at on update', async () => {
    await withDb(testDb.url, async (db) => {
      const [before] = await db
        .insert(profiles)
        .values({ handle: 'will.update' })
        .returning({ id: profiles.id, updatedAt: profiles.updatedAt });
      if (!before) throw new Error('insert returned no row');
      const [after] = await db
        .update(profiles)
        .set({ displayName: 'New name' })
        .where(eq(profiles.id, before.id))
        .returning({ updatedAt: profiles.updatedAt });
      expect(after?.updatedAt.getTime()).toBeGreaterThan(before.updatedAt.getTime());
    });
  });
});

describe('profile_members', () => {
  it('lets one login own several profiles but have only one active', async () => {
    const userId = await createAuthUser();
    await withDb(testDb.url, async (db) => {
      await db.insert(profileMembers).values([
        { userId, profileId: SEED_PROFILE_IDS.personal, isActive: true },
        { userId, profileId: SEED_PROFILE_IDS.business, isActive: false },
      ]);
      expect(await db.$count(profileMembers, eq(profileMembers.userId, userId))).toBe(2);

      await expect(
        db
          .update(profileMembers)
          .set({ isActive: true })
          .where(eq(profileMembers.profileId, SEED_PROFILE_IDS.business)),
      ).rejects.toMatchObject({ cause: { code: '23505' } });
    });
  });

  it('removes memberships when the login is deleted', async () => {
    const userId = await createAuthUser();
    await withDb(testDb.url, async (db) => {
      await db.insert(profileMembers).values({ userId, profileId: SEED_PROFILE_IDS.creator });
      await db.execute(sql`DELETE FROM auth.users WHERE id = ${userId}`);
      expect(await db.$count(profileMembers, eq(profileMembers.userId, userId))).toBe(0);
      expect(await db.$count(profiles, eq(profiles.id, SEED_PROFILE_IDS.creator))).toBe(1);
    });
  });
});

describe('media', () => {
  it('cannot be marked ready without sizes, dimensions, thumbhash and colour', async () => {
    await withDb(testDb.url, async (db) => {
      await expect(
        db.insert(media).values({
          ownerProfileId: SEED_PROFILE_IDS.creator,
          originalKey: 'originals/incomplete.heic',
          status: 'ready',
        }),
      ).rejects.toMatchObject({ cause: { code: '23514' } });

      await db.insert(media).values({
        ownerProfileId: SEED_PROFILE_IDS.creator,
        originalKey: 'originals/complete.heic',
        status: 'ready',
        key1080: 'm/complete/1080.webp',
        key600: 'm/complete/600.webp',
        key300: 'm/complete/300.webp',
        width: 1080,
        height: 1440,
        thumbhash: '1QcSHQRnh493V4dIh4eXh1h4kJUI',
        dominantColor: '#a1b2c3',
      });
    });
  });
});
