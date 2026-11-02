import { type Db, eq, media } from '@outfitly/db';
import { MAX_UPLOAD_BYTES, type Media, MEDIA_SIZES, type MediaSize } from '@outfitly/shared';
import type { PhotoStorage } from '../storage.ts';
import { type ProcessedImage, processImage } from './image.ts';

export function originalKey(mediaId: string): string {
  return `originals/${mediaId}`;
}

/** Public keys contain the media id, which is never reused, so URLs never change meaning. */
export function sizeKey(mediaId: string, size: MediaSize): string {
  return `m/${mediaId}/${String(size)}.webp`;
}

export interface StoredSizes {
  image: ProcessedImage;
  keys: Record<MediaSize, string>;
}

/** Reads an uploaded original, makes the public sizes and stores them. No database access. */
export async function makePublicSizes(
  storage: PhotoStorage,
  mediaId: string,
): Promise<StoredSizes> {
  const original = await storage.getOriginal(originalKey(mediaId));
  if (original.length > MAX_UPLOAD_BYTES) throw new Error('Original is larger than allowed.');
  const image = await processImage(original);
  for (const variant of image.variants) {
    await storage.putPublic(sizeKey(mediaId, variant.size), variant.body, 'image/webp');
  }
  const keys = Object.fromEntries(MEDIA_SIZES.map((s) => [s, sizeKey(mediaId, s)])) as Record<
    MediaSize,
    string
  >;
  return { image, keys };
}

/** Background job body: process one uploaded photo and mark it ready. */
export async function processUploadedMedia(
  db: Db,
  storage: PhotoStorage,
  mediaId: string,
): Promise<void> {
  const [row] = await db.select({ status: media.status }).from(media).where(eq(media.id, mediaId));
  if (row?.status !== 'processing') return; // Already done, or never completed by the app.

  const { image, keys } = await makePublicSizes(storage, mediaId);
  await db
    .update(media)
    .set({
      status: 'ready',
      key1080: keys[1080],
      key600: keys[600],
      key300: keys[300],
      width: image.width,
      height: image.height,
      thumbhash: image.thumbhash,
      dominantColor: image.dominantColor,
      error: null,
    })
    .where(eq(media.id, mediaId));
}

export async function markMediaFailed(db: Db, mediaId: string, reason: string): Promise<void> {
  await db
    .update(media)
    .set({ status: 'failed', error: reason.slice(0, 500) })
    .where(eq(media.id, mediaId));
}

/** The API shape of a media row. */
export function toMediaResponse(row: typeof media.$inferSelect, storage: PhotoStorage): Media {
  const { key1080, key600, key300 } = row;
  const ready = row.status === 'ready' && key1080 && key600 && key300;
  return {
    id: row.id,
    status: row.status,
    width: row.width,
    height: row.height,
    thumbhash: row.thumbhash,
    dominantColor: row.dominantColor,
    urls: ready
      ? {
          1080: storage.publicUrl(key1080),
          600: storage.publicUrl(key600),
          300: storage.publicUrl(key300),
        }
      : null,
  };
}
