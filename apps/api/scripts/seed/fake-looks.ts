// Fake looks for speed tests only: fixed ids, placeholder pictures, one command to remove them all.
import {
  type Db,
  follows,
  inArray,
  lookMedia,
  looks,
  media,
  or,
  profiles,
  tasteProfiles,
} from '@outfitly/db';
import { lookSlug, OCCASIONS, SEASONS } from '@outfitly/shared';
import sharp from 'sharp';
import type { PhotoStorage } from '../../src/storage.ts';
import { ensureAuthor, fixedUuid, mapLimit, storeSeedPhoto } from './common.ts';

export const FAKE_AUTHORS = Array.from({ length: 20 }, (_, i) => {
  const n = String(i + 1).padStart(2, '0');
  return {
    id: fixedUuid('loadtest-author', n),
    handle: `loadtest.${n}`,
    displayName: `Load Test ${n}`,
  };
});
const FAKE_AUTHOR_IDS = FAKE_AUTHORS.map((a) => a.id);

/** Width:height of the placeholder pictures, so the grid gets mixed heights. */
const RATIOS = [
  [3, 4],
  [4, 5],
  [2, 3],
  [9, 16],
  [1, 1],
] as const;

/**
 * A diagonal gradient with film grain (JPEG) standing in for an outfit photo.
 * The grain makes each picture about as heavy as a real photo, so scrolling
 * tests download and decode realistic amounts.
 */
export async function placeholderPhoto(index: number, width = 1200): Promise<Buffer> {
  const [w, h] = RATIOS[index % RATIOS.length] ?? [3, 4];
  const height = Math.round((width * h) / w);
  const hue = (index * 47) % 360;
  const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="${String(width)}" height="${String(height)}">
    <defs><linearGradient id="g" x1="0" y1="0" x2="1" y2="1">
      <stop offset="0" stop-color="hsl(${String(hue)},45%,75%)"/>
      <stop offset="1" stop-color="hsl(${String((hue + 40) % 360)},40%,35%)"/>
    </linearGradient></defs>
    <rect width="100%" height="100%" fill="url(#g)"/></svg>`;
  // Same index, same bytes: the seed loader recognises a photo by its content.
  const r = random(index + 1_000_003);
  const grain = Buffer.alloc(width * height);
  for (let i = 0; i < grain.length; i++) grain[i] = Math.round(64 + 64 * (r() + r()));
  return sharp(Buffer.from(svg))
    .composite([{ input: grain, raw: { width, height, channels: 1 }, blend: 'soft-light' }])
    .jpeg({ quality: 85 })
    .toBuffer();
}

/** Small deterministic random numbers, so a re-run makes the same looks. */
function random(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

const COLOURS = ['camel', 'black', 'cream', 'navy', 'olive', 'grey', 'rust', 'white', 'denim'];
const PIECES = ['coat', 'blazer', 'knit', 'trench', 'shirt', 'dress', 'jeans', 'trousers', 'skirt'];
const EXTRAS = ['loafers', 'sneakers', 'boots', 'a tote', 'a scarf', 'gold hoops', 'a belt'];

function pick<T>(items: readonly T[], r: () => number): T {
  return items[Math.floor(r() * items.length)] as T;
}

function fakeLook(index: number, pool: readonly string[], now: number) {
  const r = random(index + 1);
  const id = fixedUuid('loadtest-look', String(index));
  const caption = `${pick(COLOURS, r)} ${pick(PIECES, r)} with ${pick(EXTRAS, r)}`;
  const photoCount = 1 + Math.floor(r() * 3);
  // Covers go round the pool in order, so N looks with N pictures all look different.
  const start = index % pool.length;
  const photos = Array.from(
    { length: photoCount },
    (_, i) => pool[(start + i) % pool.length] ?? '',
  );
  const publishedAt = new Date(now - Math.floor(r() * 90 * 24 * 60 * 60 * 1000));
  return {
    look: {
      id,
      authorProfileId: FAKE_AUTHOR_IDS[index % FAKE_AUTHOR_IDS.length] ?? '',
      caption: caption.charAt(0).toUpperCase() + caption.slice(1),
      slug: lookSlug(caption, id),
      status: 'published' as const,
      occasionTags: [pick(OCCASIONS, r)],
      seasonTags: [pick(SEASONS, r)],
      publishedAt,
      createdAt: publishedAt,
    },
    photos: photos.map((mediaId, position) => ({ lookId: id, mediaId, position })),
  };
}

export interface FakeLooksOptions {
  db: Db;
  storage: PhotoStorage;
  /** Total fake looks wanted; missing ones are added (numbers 0 … count-1). */
  count: number;
  /** Placeholder pictures, made once and shared by all fake looks. */
  poolSize?: number;
  /** Placeholder width in pixels (tests use small ones). */
  photoWidth?: number;
  log?: (line: string) => void;
}

/** Adds fake looks until there are `count`. Safe to run again. */
export async function seedFakeLooks(options: FakeLooksOptions): Promise<{ inserted: number }> {
  const { db, storage, count, poolSize = 30, photoWidth = 1200, log = () => undefined } = options;
  for (const author of FAKE_AUTHORS) {
    const id = await ensureAuthor(db, author);
    // Never attach test looks to a real profile that happens to use the handle.
    if (id !== author.id) throw new Error(`@${author.handle} belongs to another profile.`);
  }

  // `-v2`: the grainy pictures. New ids, because a photo's links never change content.
  const pool = Array.from({ length: poolSize }, (_, i) =>
    fixedUuid('loadtest-photo-v2', String(i)),
  );
  const stored = await mapLimit(pool, 4, async (mediaId, i) =>
    storeSeedPhoto(db, storage, {
      mediaId,
      ownerProfileId: FAKE_AUTHOR_IDS[0] ?? '',
      body: await placeholderPhoto(i, photoWidth),
      contentType: 'image/jpeg',
    }),
  );
  const failed = stored.find((s) => s.status === 'rejected');
  if (failed) throw failed.reason;
  log(`Placeholder pictures ready (${String(poolSize)}).`);

  const now = Date.now();
  let inserted = 0;
  for (let from = 0; from < count; from += 500) {
    const batch = Array.from({ length: Math.min(500, count - from) }, (_, i) =>
      fakeLook(from + i, pool, now),
    );
    await db.transaction(async (tx) => {
      const rows = await tx
        .insert(looks)
        .values(batch.map((b) => b.look))
        .onConflictDoNothing()
        .returning({ id: looks.id });
      inserted += rows.length;
      await tx
        .insert(lookMedia)
        .values(batch.flatMap((b) => b.photos))
        .onConflictDoNothing();
    });
    log(`  ${String(Math.min(from + 500, count))}/${String(count)}`);
  }
  return { inserted };
}

/** Deletes every fake look, its placeholder pictures and the fake profiles. */
export async function removeFakeLooks(db: Db): Promise<{ looks: number }> {
  return db.transaction(async (tx) => {
    // Saves, board items, swipes and seen rows of these looks go with them (cascade).
    const removed = await tx
      .delete(looks)
      .where(inArray(looks.authorProfileId, FAKE_AUTHOR_IDS))
      .returning({ id: looks.id });
    await tx
      .delete(follows)
      .where(
        or(
          inArray(follows.followerProfileId, FAKE_AUTHOR_IDS),
          inArray(follows.followedProfileId, FAKE_AUTHOR_IDS),
        ),
      );
    await tx.delete(tasteProfiles).where(inArray(tasteProfiles.profileId, FAKE_AUTHOR_IDS));
    await tx.delete(media).where(inArray(media.ownerProfileId, FAKE_AUTHOR_IDS));
    await tx.delete(profiles).where(inArray(profiles.id, FAKE_AUTHOR_IDS));
    return { looks: removed.length };
  });
}

/** How many fake looks are in the database. */
export async function countFakeLooks(db: Db): Promise<number> {
  return db.$count(looks, inArray(looks.authorProfileId, FAKE_AUTHOR_IDS));
}
