import { createHash } from 'node:crypto';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  and,
  asc,
  eq,
  inArray,
  isNull,
  lookMedia,
  looks,
  media,
  profiles,
  saves,
} from '@outfitly/db';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  countFakeLooks,
  FAKE_AUTHORS,
  placeholderPhoto,
  removeFakeLooks,
  seedFakeLooks,
} from '../scripts/seed/fake-looks.ts';
import { fixedUuid } from '../scripts/seed/common.ts';
import {
  readSeedFile,
  SeedFileError,
  seedLooks,
  writeSeedTemplate,
} from '../scripts/seed/looks.ts';
import { createTestContext, type TestContext } from './helpers.ts';

let ctx: TestContext;
const folders: string[] = [];

beforeAll(async () => {
  ctx = await createTestContext();
});

afterAll(async () => {
  await ctx.close();
  await Promise.all(folders.map((f) => rm(f, { recursive: true, force: true })));
});

/** A temp folder with small generated photos (name → picture number) and optional looks.json. */
async function photoFolder(photos: Record<string, number>, seedFile?: unknown): Promise<string> {
  const folder = await mkdtemp(join(tmpdir(), 'outfitly-seed-'));
  folders.push(folder);
  for (const [name, picture] of Object.entries(photos)) {
    await writeFile(join(folder, name), await placeholderPhoto(picture, 160));
  }
  if (seedFile !== undefined) await writeFile(join(folder, 'looks.json'), JSON.stringify(seedFile));
  return folder;
}

const LOOKS_FILE = [
  {
    photos: ['coat-front.jpg', 'coat-back.jpg'],
    caption: 'Camel coat over a grey knit',
    tags: ['work', 'autumn', 'winter', 'classic'],
    author: 'seed.anna',
    authorName: 'Anna',
  },
  { photos: ['summer.png'], caption: '', tags: ['summer'], author: 'seed.anna' },
];

describe('pnpm seed:looks --init', () => {
  it('writes one look per photo in natural order, skipping other files', async () => {
    const folder = await photoFolder({ 'b10.jpg': 1, 'b2.jpg': 2, 'a.PNG': 3 });
    await writeFile(join(folder, 'notes.txt'), 'not a photo');
    await writeFile(join(folder, '.DS_Store'), '');

    expect(await writeSeedTemplate(folder)).toBe(3);
    const written = JSON.parse(await readFile(join(folder, 'looks.json'), 'utf8')) as unknown[];
    expect(written).toEqual(
      ['a.PNG', 'b2.jpg', 'b10.jpg'].map((photo) => ({
        photos: [photo],
        caption: '',
        tags: [],
        author: 'outfitly.edit',
      })),
    );
    // The template is valid as it is, and never overwritten.
    expect(await readSeedFile(folder)).toHaveLength(3);
    await expect(writeSeedTemplate(folder)).rejects.toBeInstanceOf(SeedFileError);
  });
});

describe('pnpm seed:looks', () => {
  let folder: string;

  beforeAll(async () => {
    folder = await photoFolder(
      { 'coat-front.jpg': 1, 'coat-back.jpg': 2, 'summer.png': 3 },
      LOOKS_FILE,
    );
  });

  async function seededLooks() {
    const [author] = await ctx.db.select().from(profiles).where(eq(profiles.handle, 'seed.anna'));
    const rows = await ctx.db
      .select()
      .from(looks)
      .where(eq(looks.authorProfileId, author?.id ?? ''))
      .orderBy(asc(looks.publishedAt));
    return { author, rows };
  }

  it('creates published looks with their photos in order, through the photo pipeline', async () => {
    const result = await seedLooks({ db: ctx.db, storage: ctx.storage, folder });
    expect(result).toEqual({
      looksCreated: 2,
      looksUpdated: 0,
      looksRetired: 0,
      photosProcessed: 3,
      photosSkipped: 0,
      failures: [],
    });

    const { author, rows } = await seededLooks();
    expect(author).toMatchObject({ displayName: 'Anna', accountType: 'creator' });
    // The first look in the file is the newest.
    const [summer, coat] = rows;
    expect(coat).toMatchObject({
      caption: 'Camel coat over a grey knit',
      status: 'published',
      occasionTags: ['work'],
      seasonTags: ['autumn', 'winter'],
      styleTags: ['classic'],
      isSponsored: false,
    });
    expect(coat?.slug).toMatch(/^camel-coat-over-a-grey-knit-[0-9a-f]{12}$/);
    expect(summer).toMatchObject({
      caption: null,
      seasonTags: ['summer'],
      occasionTags: [],
      styleTags: [],
    });
    expect(summer?.slug).toMatch(/^look-[0-9a-f]{12}$/);

    const photos = await ctx.db
      .select({ position: lookMedia.position, status: media.status, key300: media.key300 })
      .from(lookMedia)
      .innerJoin(media, eq(media.id, lookMedia.mediaId))
      .where(eq(lookMedia.lookId, coat?.id ?? ''))
      .orderBy(asc(lookMedia.position));
    expect(photos.map((p) => [p.position, p.status])).toEqual([
      [0, 'ready'],
      [1, 'ready'],
    ]);
    // Public sizes were really made and stored (originals too, privately).
    expect(ctx.storage.publicObjects.has(photos[0]?.key300 ?? '')).toBe(true);
    expect(ctx.storage.originals.size).toBeGreaterThanOrEqual(3);
  });

  it('creates no duplicates when run again', async () => {
    const before = await ctx.db.$count(looks);
    const result = await seedLooks({ db: ctx.db, storage: ctx.storage, folder });
    expect(result).toMatchObject({
      looksCreated: 0,
      looksUpdated: 2,
      photosProcessed: 0,
      photosSkipped: 3,
    });
    expect(await ctx.db.$count(looks)).toBe(before);
    expect(await ctx.db.$count(profiles, eq(profiles.handle, 'seed.anna'))).toBe(1);
  });

  it('updates a look in place when its caption or tags change', async () => {
    const { rows: before } = await seededLooks();
    const edited = structuredClone(LOOKS_FILE);
    edited[0] = {
      ...LOOKS_FILE[0],
      caption: 'Camel coat, white sneakers',
      tags: ['everyday'],
    } as (typeof edited)[0];
    await writeFile(join(folder, 'looks.json'), JSON.stringify(edited));

    await seedLooks({ db: ctx.db, storage: ctx.storage, folder });
    const { rows: after } = await seededLooks();
    expect(after.map((r) => r.id)).toEqual(before.map((r) => r.id));
    expect(after[1]).toMatchObject({
      caption: 'Camel coat, white sneakers',
      occasionTags: ['everyday'],
      seasonTags: [],
    });
    expect(after[1]?.slug).toMatch(/^camel-coat-white-sneakers-/);
    expect(after[1]?.publishedAt).toEqual(before[1]?.publishedAt);
  });

  it('skips a look whose photo is broken, reports it, and still loads the rest', async () => {
    const broken = await photoFolder({ 'good.jpg': 7 }, [
      { photos: ['good.jpg'], tags: [], author: 'seed.bo' },
      { photos: ['broken.jpg'], tags: [], author: 'seed.bo' },
    ]);
    await writeFile(join(broken, 'broken.jpg'), Buffer.from('definitely not a jpeg'));

    const result = await seedLooks({ db: ctx.db, storage: ctx.storage, folder: broken });
    expect(result.looksCreated).toBe(1);
    expect(result.failures).toEqual([
      { photo: 'broken.jpg', reason: expect.any(String) as string },
    ]);
    const failed = await ctx.db.select().from(media).where(eq(media.status, 'failed'));
    expect(failed).toHaveLength(1);
  });
});

describe('pnpm seed:looks after editing looks.json', () => {
  /** Active looks of an author, each as its photo files in order. */
  async function activeLooks(handle: string, folder: string, files: string[]) {
    const fileOf = new Map<string, string>();
    for (const file of files) {
      const hash = createHash('sha256')
        .update(await readFile(join(folder, file)))
        .digest('hex');
      fileOf.set(fixedUuid('seed-photo', hash), file);
    }
    const rows = await ctx.db
      .select({ lookId: looks.id, mediaId: lookMedia.mediaId })
      .from(looks)
      .innerJoin(profiles, eq(profiles.id, looks.authorProfileId))
      .innerJoin(lookMedia, eq(lookMedia.lookId, looks.id))
      .where(and(eq(profiles.handle, handle), isNull(looks.deletedAt)))
      .orderBy(asc(lookMedia.position));
    const grouped = new Map<string, string[]>();
    for (const r of rows) {
      grouped.set(r.lookId, [...(grouped.get(r.lookId) ?? []), fileOf.get(r.mediaId) ?? '?']);
    }
    return [...grouped.values()].sort();
  }

  it('keeps every photo in exactly one look when photos are regrouped or the cover changes', async () => {
    const files = ['a.jpg', 'b.jpg'];
    const folder = await photoFolder({ 'a.jpg': 11, 'b.jpg': 12 });
    const run = async (groups: string[][]) => {
      await writeFile(
        join(folder, 'looks.json'),
        JSON.stringify(groups.map((photos) => ({ photos, author: 'seed.regroup' }))),
      );
      return seedLooks({ db: ctx.db, storage: ctx.storage, folder });
    };

    await run([['a.jpg'], ['b.jpg']]);
    expect(await activeLooks('seed.regroup', folder, files)).toEqual([['a.jpg'], ['b.jpg']]);

    // Grouped into one look: b's single-photo look is retired.
    expect((await run([['a.jpg', 'b.jpg']])).looksRetired).toBe(1);
    expect(await activeLooks('seed.regroup', folder, files)).toEqual([['a.jpg', 'b.jpg']]);

    // New cover: the look known by b comes back with both photos, a's is retired.
    expect((await run([['b.jpg', 'a.jpg']])).looksRetired).toBe(1);
    expect(await activeLooks('seed.regroup', folder, files)).toEqual([['b.jpg', 'a.jpg']]);

    // Running the same file again changes nothing.
    expect((await run([['b.jpg', 'a.jpg']])).looksRetired).toBe(0);
  });

  it("moves a look's photos to its new author", async () => {
    const folder = await photoFolder({ 'own.jpg': 13 }, [
      { photos: ['own.jpg'], author: 'seed.first' },
    ]);
    await seedLooks({ db: ctx.db, storage: ctx.storage, folder });
    await writeFile(
      join(folder, 'looks.json'),
      JSON.stringify([{ photos: ['own.jpg'], author: 'seed.second' }]),
    );
    await seedLooks({ db: ctx.db, storage: ctx.storage, folder });

    const owners = await ctx.db
      .select({ handle: profiles.handle })
      .from(media)
      .innerJoin(profiles, eq(profiles.id, media.ownerProfileId))
      .where(inArray(profiles.handle, ['seed.first', 'seed.second']));
    expect(owners).toEqual([{ handle: 'seed.second' }]);
  });

  it('refuses a photo over 25 MB before uploading it', async () => {
    const folder = await photoFolder({}, [{ photos: ['huge.jpg'], author: 'seed.huge' }]);
    await writeFile(join(folder, 'huge.jpg'), Buffer.alloc(26 * 1024 * 1024));
    const originals = ctx.storage.originals.size;
    const result = await seedLooks({ db: ctx.db, storage: ctx.storage, folder });
    expect(result.failures).toEqual([
      { photo: 'huge.jpg', reason: 'The photo is larger than 25 MB.' },
    ]);
    expect(result.looksCreated).toBe(0);
    expect(ctx.storage.originals.size).toBe(originals);
  });
});

describe('looks.json checks', () => {
  async function problemsWith(seedFile: unknown, photos: Record<string, number> = { 'a.jpg': 1 }) {
    const folder = await photoFolder(photos, seedFile);
    const error = await readSeedFile(folder).then(
      () => null,
      (e: unknown) => e,
    );
    expect(error).toBeInstanceOf(SeedFileError);
    return (error as Error).message;
  }

  it('names the look and lists the allowed tags for an unknown tag', async () => {
    const message = await problemsWith([
      { photos: ['a.jpg'], tags: ['autumn'], author: 'seed.anna' },
      { photos: ['a.jpg'], tags: ['monsoon'], author: 'seed.anna' },
    ]);
    expect(message).toContain('look 2 (tags)');
    expect(message).toContain('everyday, work');
  });

  it('refuses paths outside the folder, unknown file types and bad handles', async () => {
    const message = await problemsWith([
      { photos: ['../secret.jpg'], author: 'seed.anna' },
      { photos: ['clip.gif'], author: 'seed.anna' },
      { photos: ['a.jpg'], author: 'Anna Svensson' },
    ]);
    expect(message).toContain('look 1 (photos)');
    expect(message).toContain('look 2 (photos)');
    expect(message).toContain('look 3 (author)');
  });

  it('refuses unknown fields (typos) and a photo used in two looks', async () => {
    expect(
      await problemsWith([{ photos: ['a.jpg'], author: 'seed.anna', captoin: 'x' }]),
    ).toContain('captoin');
    expect(
      await problemsWith(
        [
          { photos: ['a.jpg'], author: 'seed.anna' },
          { photos: ['b.jpg', 'a.jpg'], author: 'seed.anna' },
        ],
        { 'a.jpg': 1, 'b.jpg': 2 },
      ),
    ).toContain('a.jpg is already in look 1');
  });

  it('says so when the folder does not exist', async () => {
    await expect(readSeedFile('/no/such/folder')).rejects.toThrow(
      'Folder not found: /no/such/folder',
    );
    await expect(writeSeedTemplate('/no/such/folder')).rejects.toBeInstanceOf(SeedFileError);
  });

  it('lists photos that are missing from the folder', async () => {
    expect(await problemsWith([{ photos: ['a.jpg', 'gone.jpg'], author: 'seed.anna' }])).toContain(
      'gone.jpg',
    );
  });

  it('refuses the same picture saved under two names before uploading anything', async () => {
    const folder = await photoFolder({ 'one.jpg': 4, 'copy.jpg': 4 }, [
      { photos: ['one.jpg'], author: 'seed.dup' },
      { photos: ['copy.jpg'], author: 'seed.dup' },
    ]);
    const originals = ctx.storage.originals.size;
    await expect(seedLooks({ db: ctx.db, storage: ctx.storage, folder })).rejects.toThrow(
      'one.jpg = copy.jpg',
    );
    expect(ctx.storage.originals.size).toBe(originals);
  });
});

describe('pnpm seed:fake-looks', () => {
  const options = () => ({ db: ctx.db, storage: ctx.storage, poolSize: 4, photoWidth: 120 });

  it('tops up to the requested number of fake looks, with no duplicates', async () => {
    expect(await seedFakeLooks({ ...options(), count: 30 })).toEqual({ inserted: 30, restyled: 0 });
    expect(await seedFakeLooks({ ...options(), count: 30 })).toEqual({ inserted: 0, restyled: 0 });
    expect(await seedFakeLooks({ ...options(), count: 40 })).toEqual({ inserted: 10, restyled: 0 });
    expect(await countFakeLooks(ctx.db)).toBe(40);

    const authorIds = FAKE_AUTHORS.map((a) => a.id);
    const fake = await ctx.db.select().from(looks).where(inArray(looks.authorProfileId, authorIds));
    expect(new Set(fake.map((l) => l.authorProfileId)).size).toBe(20);
    expect(fake.every((l) => l.status === 'published' && l.publishedAt !== null)).toBe(true);
    const links = await ctx.db
      .select()
      .from(lookMedia)
      .where(
        inArray(
          lookMedia.lookId,
          fake.map((l) => l.id),
        ),
      );
    expect(links.length).toBeGreaterThanOrEqual(40);
    expect(links.length).toBeLessThanOrEqual(120);
    expect(fake.every((l) => l.styleTags.length === 1)).toBe(true);
  });

  it('gives a style to fake looks made before styles existed, and only to those', async () => {
    const authorIds = FAKE_AUTHORS.map((a) => a.id);
    const before = await ctx.db
      .select()
      .from(looks)
      .where(inArray(looks.authorProfileId, authorIds));
    const [first, second] = before;
    await ctx.db
      .update(looks)
      .set({ styleTags: [] })
      .where(inArray(looks.id, [first?.id ?? '', second?.id ?? '']));

    expect(await seedFakeLooks({ ...options(), count: 40 })).toEqual({ inserted: 0, restyled: 2 });
    const after = await ctx.db
      .select()
      .from(looks)
      .where(inArray(looks.authorProfileId, authorIds));
    const styleOf = (rows: typeof before) => new Map(rows.map((l) => [l.id, l.styleTags]));
    // The same style as a fresh run would give, and every other look untouched.
    expect(styleOf(after)).toEqual(styleOf(before));
  });

  it('removes every fake look, picture and poster in one go, leaving real data alone', async () => {
    const [someone] = await ctx.db.insert(profiles).values({ handle: 'real.person' }).returning();
    const [aFakeLook] = await ctx.db
      .select({ id: looks.id })
      .from(looks)
      .where(
        inArray(
          looks.authorProfileId,
          FAKE_AUTHORS.map((a) => a.id),
        ),
      )
      .limit(1);
    await ctx.db
      .insert(saves)
      .values({ profileId: someone?.id ?? '', lookId: aFakeLook?.id ?? '' });

    expect(await removeFakeLooks(ctx.db)).toEqual({ looks: 40 });
    expect(await countFakeLooks(ctx.db)).toBe(0);
    expect(
      await ctx.db.$count(
        profiles,
        inArray(
          profiles.id,
          FAKE_AUTHORS.map((a) => a.id),
        ),
      ),
    ).toBe(0);
    expect(
      await ctx.db.$count(
        media,
        inArray(
          media.ownerProfileId,
          FAKE_AUTHORS.map((a) => a.id),
        ),
      ),
    ).toBe(0);
    expect(await ctx.db.$count(profiles, eq(profiles.handle, 'real.person'))).toBe(1);
    expect(await ctx.db.$count(saves, eq(saves.profileId, someone?.id ?? ''))).toBe(0);
    // Real looks from the photo loader are untouched.
    expect(await ctx.db.$count(looks)).toBeGreaterThan(0);
  });

  it('refuses to post as a real profile that took a test handle', async () => {
    await ctx.db.insert(profiles).values({ handle: 'loadtest.01' });
    await expect(seedFakeLooks({ ...options(), count: 1 })).rejects.toThrow(
      '@loadtest.01 belongs to another profile',
    );
  });
});
