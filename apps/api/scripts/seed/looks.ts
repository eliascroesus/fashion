// Loads real outfit photos + looks.json into the database as published looks (see README "Seed looks").
import { createHash } from 'node:crypto';
import { existsSync, statSync } from 'node:fs';
import { readdir, readFile, writeFile } from 'node:fs/promises';
import { extname, join } from 'node:path';
import { type Db, eq, lookMedia, looks, sql } from '@outfitly/db';
import { LOOK_TAGS, lookSlug, MAX_LOOK_PHOTOS, splitLookTags } from '@outfitly/shared';
import { z } from 'zod';
import type { PhotoStorage } from '../../src/storage.ts';
import {
  ensureAuthor,
  fixedUuid,
  HANDLE_PATTERN,
  mapLimit,
  PHOTO_TYPES,
  storeSeedPhoto,
} from './common.ts';

export const SEED_FILE = 'looks.json';
/** Who posts the looks in a fresh template; change it per look in looks.json. */
export const DEFAULT_AUTHOR = 'outfitly.edit';

const photoFile = z
  .string()
  .refine((name) => !/[/\\]/.test(name) && !name.startsWith('.'), {
    error: 'must be a file name in the folder (no folders, no "..")',
  })
  .refine((name) => extname(name).toLowerCase() in PHOTO_TYPES, {
    error: `must be one of ${Object.keys(PHOTO_TYPES).join(' ')}`,
  });

const entrySchema = z.strictObject({
  photos: z.array(photoFile).min(1).max(MAX_LOOK_PHOTOS),
  caption: z
    .string()
    .max(2000)
    .optional()
    .transform((c) => c?.trim() || null),
  tags: z
    .array(z.enum(LOOK_TAGS, { error: `unknown tag; use any of: ${LOOK_TAGS.join(', ')}` }))
    .default([]),
  author: z.string().regex(HANDLE_PATTERN, {
    error: '3–30 lowercase letters, digits, dots or underscores',
  }),
  authorName: z.string().trim().min(1).max(60).optional(),
});
export type SeedEntry = z.infer<typeof entrySchema>;

const seedFileSchema = z
  .array(entrySchema)
  .min(1)
  .superRefine((entries, ctx) => {
    // A look is known by its first photo, so each photo may only be in one look.
    const seen = new Map<string, number>();
    entries.forEach((entry, i) => {
      for (const photo of entry.photos) {
        const first = seen.get(photo);
        if (first !== undefined) {
          ctx.addIssue({
            code: 'custom',
            path: [i, 'photos'],
            message: `${photo} is already in look ${String(first + 1)}; each photo can be in one look`,
          });
        }
        seen.set(photo, i);
      }
    });
  });

export class SeedFileError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'SeedFileError';
  }
}

function assertFolder(folder: string): void {
  if (!existsSync(folder) || !statSync(folder).isDirectory()) {
    throw new SeedFileError(`Folder not found: ${folder}`);
  }
}

/** Reads and checks looks.json, with problems listed per look ("look 3: tags: …"). */
export async function readSeedFile(folder: string): Promise<SeedEntry[]> {
  assertFolder(folder);
  const path = join(folder, SEED_FILE);
  if (!existsSync(path)) {
    throw new SeedFileError(`No ${SEED_FILE} in ${folder}. Create one with --init.`);
  }
  let raw: unknown;
  try {
    raw = JSON.parse(await readFile(path, 'utf8'));
  } catch (error) {
    throw new SeedFileError(`${SEED_FILE} is not valid JSON: ${(error as Error).message}`);
  }
  const result = seedFileSchema.safeParse(raw);
  if (!result.success) {
    const problems = result.error.issues.map((issue) => {
      const [index, ...rest] = issue.path;
      const where = typeof index === 'number' ? `look ${String(index + 1)}` : 'file';
      const field = rest.filter((p) => typeof p === 'string').join('.');
      return `  ${where}${field ? ` (${field})` : ''}: ${issue.message}`;
    });
    throw new SeedFileError(`${SEED_FILE} has problems:\n${problems.join('\n')}`);
  }
  const missing = result.data
    .flatMap((e) => e.photos)
    .filter((photo) => !existsSync(join(folder, photo)));
  if (missing.length > 0) {
    throw new SeedFileError(
      `Photos listed in ${SEED_FILE} but not in the folder: ${missing.join(', ')}`,
    );
  }
  return result.data;
}

/** Writes a looks.json with one look per photo in the folder (never overwrites one). */
export async function writeSeedTemplate(folder: string): Promise<number> {
  assertFolder(folder);
  const path = join(folder, SEED_FILE);
  if (existsSync(path)) throw new SeedFileError(`${path} already exists; not overwriting it.`);
  const photos = (await readdir(folder))
    .filter((name) => !name.startsWith('.') && extname(name).toLowerCase() in PHOTO_TYPES)
    .sort((a, b) => a.localeCompare(b, 'en', { numeric: true }));
  if (photos.length === 0) throw new SeedFileError(`No photos found in ${folder}.`);
  const template = photos.map((photo) => ({
    photos: [photo],
    caption: '',
    tags: [],
    author: DEFAULT_AUTHOR,
  }));
  await writeFile(path, `${JSON.stringify(template, null, 2)}\n`);
  return photos.length;
}

export interface SeedResult {
  looksCreated: number;
  looksUpdated: number;
  photosProcessed: number;
  photosSkipped: number;
  failures: { photo: string; reason: string }[];
}

export interface SeedOptions {
  db: Db;
  storage: PhotoStorage;
  folder: string;
  /** Photos processed at the same time (each in its own worker thread). */
  concurrency?: number;
  log?: (line: string) => void;
}

/**
 * Creates (or updates) one published look per entry. Safe to run again: the
 * same photo is the same media row, and a look is identified by its first
 * photo. Looks whose photos failed are left out and reported.
 */
export async function seedLooks(options: SeedOptions): Promise<SeedResult> {
  const { db, storage, folder, concurrency = 4, log = () => undefined } = options;
  const entries = await readSeedFile(folder);

  const authorIds = new Map<string, string>();
  for (const entry of entries) {
    if (authorIds.has(entry.author)) continue;
    const displayName = entry.authorName ?? entry.author;
    authorIds.set(entry.author, await ensureAuthor(db, { handle: entry.author, displayName }));
  }

  // Photos, each once; owned by the author of the look they're in.
  const photos = entries.flatMap((entry) =>
    entry.photos.map((file) => ({ file, ownerProfileId: authorIds.get(entry.author) ?? '' })),
  );
  // The same picture under two names would be one photo in two places: refuse up front.
  const hashed = await mapLimit(photos, 8, async ({ file }) =>
    createHash('sha256')
      .update(await readFile(join(folder, file)))
      .digest('hex'),
  );
  const byHash = new Map<string, string[]>();
  hashed.forEach((h, i) => {
    if (h.status !== 'fulfilled') throw h.reason;
    byHash.set(h.value, [...(byHash.get(h.value) ?? []), photos[i]?.file ?? '?']);
  });
  const duplicates = [...byHash.values()].filter((files) => files.length > 1);
  if (duplicates.length > 0) {
    const list = duplicates.map((files) => `  ${files.join(' = ')}`).join('\n');
    throw new SeedFileError(`These files are the same picture; keep one of each:\n${list}`);
  }

  const mediaIds = new Map<string, string>();
  const failures: SeedResult['failures'] = [];
  let processed = 0;
  let skipped = 0;
  let done = 0;
  const outcomes = await mapLimit(photos, concurrency, async ({ file, ownerProfileId }, i) => {
    const body = await readFile(join(folder, file));
    const hash = hashed[i]?.status === 'fulfilled' ? hashed[i].value : '';
    const mediaId = fixedUuid('seed-photo', hash);
    const contentType = PHOTO_TYPES[extname(file).toLowerCase()] ?? 'application/octet-stream';
    try {
      const outcome = await storeSeedPhoto(db, storage, {
        mediaId,
        ownerProfileId,
        body,
        contentType,
      });
      mediaIds.set(file, mediaId);
      return outcome;
    } finally {
      log(`  ${String(++done)}/${String(photos.length)} ${file}`);
    }
  });
  outcomes.forEach((outcome, i) => {
    if (outcome.status === 'fulfilled') {
      if (outcome.value === 'processed') processed++;
      else skipped++;
    } else {
      const reason =
        outcome.reason instanceof Error ? outcome.reason.message : String(outcome.reason);
      failures.push({ photo: photos[i]?.file ?? '?', reason });
    }
  });

  let created = 0;
  let updated = 0;
  const startedAt = Date.now();
  for (const [index, entry] of entries.entries()) {
    const ids = entry.photos.map((file) => mediaIds.get(file));
    if (ids.some((id) => id === undefined)) continue; // A photo failed; reported above.
    const mediaOrder = ids as string[];
    const lookId = fixedUuid('seed-look', mediaOrder[0] ?? '');
    const { occasions, seasons } = splitLookTags(entry.tags);
    const fields = {
      authorProfileId: authorIds.get(entry.author) ?? '',
      caption: entry.caption,
      slug: lookSlug(entry.caption, lookId),
      occasionTags: occasions,
      seasonTags: seasons,
      status: 'published' as const,
      deletedAt: null,
    };
    const inserted = await db.transaction(async (tx) => {
      const [row] = await tx
        .insert(looks)
        // The first look in the file is the newest, so the file order is the feed order.
        .values({ id: lookId, ...fields, publishedAt: new Date(startedAt - index * 60_000) })
        .onConflictDoUpdate({
          target: looks.id,
          set: { ...fields, publishedAt: sql`coalesce(${looks.publishedAt}, now())` },
        })
        .returning({ inserted: sql<boolean>`xmax = 0` });
      await tx.delete(lookMedia).where(eq(lookMedia.lookId, lookId));
      await tx
        .insert(lookMedia)
        .values(mediaOrder.map((mediaId, position) => ({ lookId, mediaId, position })));
      return row?.inserted ?? false;
    });
    if (inserted) created++;
    else updated++;
  }

  return {
    looksCreated: created,
    looksUpdated: updated,
    photosProcessed: processed,
    photosSkipped: skipped,
    failures,
  };
}
