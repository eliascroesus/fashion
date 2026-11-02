import { eq, sql } from 'drizzle-orm';
import pg from 'pg';
import type { Db } from '../src/client.ts';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { runMigrations } from '../src/migrate.ts';
import {
  featureFlags,
  follows,
  lookMedia,
  looks,
  media,
  profileMembers,
  profiles,
  saves,
} from '../src/schema/index.ts';
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

/** A ready photo owned by the creator seed profile. */
async function readyMedia(db: Db, name: string): Promise<string> {
  const [row] = await db
    .insert(media)
    .values({
      ownerProfileId: SEED_PROFILE_IDS.creator,
      originalKey: `originals/${name}`,
      status: 'ready',
      key1080: `m/${name}/1080.webp`,
      key600: `m/${name}/600.webp`,
      key300: `m/${name}/300.webp`,
      width: 1080,
      height: 1350,
      thumbhash: '1QcSHQRnh493V4dIh4eXh1h4kJUI',
      dominantColor: '#a1b2c3',
    })
    .returning({ id: media.id });
  if (!row) throw new Error('media insert returned no row');
  return row.id;
}

describe('looks', () => {
  it('needs a publish time once published, and a URL-safe unique slug', async () => {
    await withDb(testDb.url, async (db) => {
      const base = { authorProfileId: SEED_PROFILE_IDS.creator, status: 'published' as const };
      await expect(db.insert(looks).values({ ...base, slug: 'no-time-1' })).rejects.toMatchObject({
        cause: { code: '23514' },
      });
      await expect(
        db.insert(looks).values({ ...base, slug: 'Not A Slug', publishedAt: new Date() }),
      ).rejects.toMatchObject({ cause: { code: '23514' } });

      await db.insert(looks).values({ ...base, slug: 'camel-coat-1', publishedAt: new Date() });
      await expect(
        db.insert(looks).values({ ...base, slug: 'camel-coat-1', publishedAt: new Date() }),
      ).rejects.toMatchObject({ cause: { code: '23505' } });
    });
  });

  it('only accepts known occasion and season tags', async () => {
    await withDb(testDb.url, async (db) => {
      await db.insert(looks).values({
        authorProfileId: SEED_PROFILE_IDS.creator,
        slug: 'tagged-1',
        occasionTags: ['work', 'date'],
        seasonTags: ['autumn'],
      });
      await expect(
        db.execute(
          sql`INSERT INTO looks (author_profile_id, slug, season_tags)
              VALUES (${SEED_PROFILE_IDS.creator}, 'tagged-2', '{monsoon}')`,
        ),
      ).rejects.toMatchObject({ cause: { code: '22P02' } });
    });
  });

  it('holds at most 10 photos, each once, in a fixed order', async () => {
    await withDb(testDb.url, async (db) => {
      const [look] = await db
        .insert(looks)
        .values({ authorProfileId: SEED_PROFILE_IDS.creator, slug: 'ten-photos-1' })
        .returning({ id: looks.id });
      if (!look) throw new Error('look insert returned no row');
      const ids = [];
      for (let i = 0; i < 11; i++) ids.push(await readyMedia(db, `ten-${String(i)}`));

      await db
        .insert(lookMedia)
        .values(
          ids.slice(0, 10).map((mediaId, position) => ({ lookId: look.id, mediaId, position })),
        );
      await expect(
        db.insert(lookMedia).values({ lookId: look.id, mediaId: ids[10] ?? '', position: 10 }),
      ).rejects.toMatchObject({ cause: { code: '23514' } });
      await expect(
        db.insert(lookMedia).values({ lookId: look.id, mediaId: ids[10] ?? '', position: 3 }),
      ).rejects.toMatchObject({ cause: { code: '23505' } });
      await expect(
        db.insert(lookMedia).values({ lookId: look.id, mediaId: ids[0] ?? '', position: 9 }),
      ).rejects.toMatchObject({ cause: { code: '23505' } });

      // Deleting a look takes its photo links with it (the photos stay).
      await db.delete(looks).where(eq(looks.id, look.id));
      expect(await db.$count(lookMedia, eq(lookMedia.lookId, look.id))).toBe(0);
      expect(await db.$count(media, eq(media.id, ids[0] ?? ''))).toBe(1);
    });
  });
});

describe('saves and follows', () => {
  it('keep one row per pair and refuse following yourself', async () => {
    await withDb(testDb.url, async (db) => {
      const [look] = await db
        .insert(looks)
        .values({ authorProfileId: SEED_PROFILE_IDS.creator, slug: 'saved-1' })
        .returning({ id: looks.id });
      if (!look) throw new Error('look insert returned no row');
      const save = { profileId: SEED_PROFILE_IDS.personal, lookId: look.id };
      await db.insert(saves).values(save);
      await expect(db.insert(saves).values(save)).rejects.toMatchObject({
        cause: { code: '23505' },
      });

      const follow = {
        followerProfileId: SEED_PROFILE_IDS.personal,
        followedProfileId: SEED_PROFILE_IDS.creator,
      };
      await db.insert(follows).values(follow);
      await expect(db.insert(follows).values(follow)).rejects.toMatchObject({
        cause: { code: '23505' },
      });
      await expect(
        db.insert(follows).values({
          followerProfileId: SEED_PROFILE_IDS.personal,
          followedProfileId: SEED_PROFILE_IDS.personal,
        }),
      ).rejects.toMatchObject({ cause: { code: '23514' } });
    });
  });
});
