// Shared by the seed scripts: fixed ids, author profiles and running photos through the pipeline.
import { createHash } from 'node:crypto';
import { type Db, eq, media, profiles } from '@outfitly/db';
import { MAX_UPLOAD_BYTES } from '@outfitly/shared';
import { ImageRejectedError } from '../../src/media/image.ts';
import { markMediaFailed, originalKey, processUploadedMedia } from '../../src/media/pipeline.ts';
import type { PhotoStorage } from '../../src/storage.ts';

/** Same rule as the database's profiles_handle_format. */
export const HANDLE_PATTERN = /^[a-z0-9._]{3,30}$/;

/**
 * A UUID that is always the same for the same input, so running a seed again
 * finds its own rows instead of adding new ones. Version 8 ("custom") layout.
 */
export function fixedUuid(...parts: string[]): string {
  const hex = createHash('sha256').update(parts.join('\0')).digest('hex').slice(0, 32).split('');
  hex[12] = '8';
  hex[16] = ((parseInt(hex[16] ?? '0', 16) & 0x3) | 0x8).toString(16);
  const h = hex.join('');
  return `${h.slice(0, 8)}-${h.slice(8, 12)}-${h.slice(12, 16)}-${h.slice(16, 20)}-${h.slice(20)}`;
}

export interface Author {
  id?: string;
  handle: string;
  displayName: string;
}

/** Finds a profile by handle, creating it as a creator account if it doesn't exist. */
export async function ensureAuthor(db: Db, author: Author): Promise<string> {
  await db
    .insert(profiles)
    .values({
      ...(author.id ? { id: author.id } : {}),
      handle: author.handle,
      displayName: author.displayName,
      accountType: 'creator',
    })
    .onConflictDoNothing();
  const [row] = await db
    .select({ id: profiles.id, deletedAt: profiles.deletedAt })
    .from(profiles)
    .where(eq(profiles.handle, author.handle));
  if (!row) throw new Error(`Could not create profile @${author.handle}.`);
  if (row.deletedAt) throw new Error(`Profile @${author.handle} is deleted; pick another author.`);
  return row.id;
}

export interface SeedPhoto {
  mediaId: string;
  ownerProfileId: string;
  body: Buffer;
  contentType: string;
}

/**
 * Stores the original and makes the public sizes, exactly like an app upload
 * (minus the upload link). Photos that are already ready are left alone.
 */
export async function storeSeedPhoto(
  db: Db,
  storage: PhotoStorage,
  photo: SeedPhoto,
): Promise<'processed' | 'skipped'> {
  if (photo.body.length > MAX_UPLOAD_BYTES) {
    throw new ImageRejectedError('The photo is larger than 25 MB.');
  }
  const [row] = await db
    .select({ status: media.status, ownerProfileId: media.ownerProfileId })
    .from(media)
    .where(eq(media.id, photo.mediaId));
  if (row?.status === 'ready') {
    // The look moved to another author: its photos go with it.
    if (row.ownerProfileId !== photo.ownerProfileId) {
      await db
        .update(media)
        .set({ ownerProfileId: photo.ownerProfileId })
        .where(eq(media.id, photo.mediaId));
    }
    return 'skipped';
  }

  const fields = {
    ownerProfileId: photo.ownerProfileId,
    status: 'processing' as const,
    contentType: photo.contentType,
    byteSize: photo.body.length,
    error: null,
  };
  await db
    .insert(media)
    .values({ id: photo.mediaId, originalKey: originalKey(photo.mediaId), ...fields })
    .onConflictDoUpdate({ target: media.id, set: fields });
  await storage.putOriginal(originalKey(photo.mediaId), photo.body, photo.contentType);
  try {
    await processUploadedMedia(db, storage, photo.mediaId);
  } catch (error) {
    const reason = error instanceof ImageRejectedError ? error.message : 'Processing failed.';
    await markMediaFailed(db, photo.mediaId, reason);
    throw error;
  }
  return 'processed';
}

/** Runs `fn` over `items`, at most `limit` at a time. Results keep the order of `items`. */
export async function mapLimit<T, R>(
  items: readonly T[],
  limit: number,
  fn: (item: T, index: number) => Promise<R>,
): Promise<PromiseSettledResult<R>[]> {
  const results = new Array<PromiseSettledResult<R>>(items.length);
  let next = 0;
  async function worker(): Promise<void> {
    while (next < items.length) {
      const index = next++;
      try {
        results[index] = { status: 'fulfilled', value: await fn(items[index] as T, index) };
      } catch (reason) {
        results[index] = { status: 'rejected', reason };
      }
    }
  }
  await Promise.all(Array.from({ length: Math.min(limit, items.length) }, worker));
  return results;
}

/** Content types the pipeline accepts, by file extension. */
export const PHOTO_TYPES: Record<string, string> = {
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.png': 'image/png',
  '.webp': 'image/webp',
  '.heic': 'image/heic',
  '.heif': 'image/heif',
};
