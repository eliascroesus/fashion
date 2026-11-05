import { and, type Db, eq, isNull, media, products, sql } from '@outfitly/db';
import { MAX_UPLOAD_BYTES } from '@outfitly/shared';
import type { EmbedderClient } from '../ai/embedder.ts';
import { ImageRejectedError } from '../media/image.ts';
import { markMediaFailed, originalKey, processUploadedMedia } from '../media/pipeline.ts';
import type { PhotoStorage } from '../storage.ts';
import { LinkFetchError, type NetworkPolicy, safeFetch } from './fetch.ts';

export const PRODUCT_QUEUES = {
  /** Copies a product's shop photo into our storage and makes the public sizes. */
  productPhoto: 'product-photo',
  /** Fingerprints a product's copied photo (services/embedder). */
  productFingerprint: 'product-fingerprint',
} as const;

export interface ProductPhotoDeps {
  db: Db;
  storage: PhotoStorage;
  embedder: EmbedderClient | null;
  network?: NetworkPolicy;
}

export type ProductPhotoOutcome =
  | { outcome: 'copied'; mediaId: string }
  | { outcome: 'skipped'; reason: string }
  | { outcome: 'refused'; reason: string };

/** What shops send photos as; the photo step checks the real format from the file itself. */
const PHOTO_TYPES = ['image/', 'application/octet-stream', 'binary/octet-stream'];

/**
 * Copies a product's shop photo into our storage (the shop's link is never
 * served, and the fingerprint service only reads our own photos), through the
 * same steps as an upload. A photo already copied from the same link isn't
 * copied again. A shop that's down, slow or busy is retried (throws); the
 * rest is reported as `refused`.
 */
export async function copyProductPhoto(
  deps: ProductPhotoDeps,
  productId: string,
): Promise<ProductPhotoOutcome> {
  const { db, storage } = deps;
  const [product] = await db
    .select({
      imageUrl: products.imageUrl,
      photoId: products.imageMediaId,
      photoSource: media.sourceUrl,
      photoStatus: media.status,
    })
    .from(products)
    .leftJoin(media, and(eq(media.id, products.imageMediaId), isNull(media.deletedAt)))
    .where(and(eq(products.id, productId), isNull(products.deletedAt)));
  if (!product?.imageUrl) return { outcome: 'skipped', reason: 'no shop photo' };
  if (product.photoSource === product.imageUrl && product.photoStatus === 'ready') {
    return { outcome: 'skipped', reason: 'already copied' };
  }

  const sourceUrl = product.imageUrl;
  let photo: { body: Buffer; contentType: string };
  try {
    const answer = await safeFetch(new URL(sourceUrl), {
      accept: 'image/avif,image/webp,image/png,image/jpeg;q=0.9,*/*;q=0.5',
      maxBytes: MAX_UPLOAD_BYTES,
      overLimit: 'refuse',
      contentTypes: PHOTO_TYPES,
      network: deps.network,
    });
    photo = { body: answer.body, contentType: answer.contentType.split(';')[0] ?? '' };
  } catch (error) {
    if (error instanceof LinkFetchError && !retryable(error)) {
      return { outcome: 'refused', reason: error.message };
    }
    throw error;
  }

  const mediaId = crypto.randomUUID();
  const key = originalKey(mediaId);
  await storage.putOriginal(key, photo.body, photo.contentType);
  await db.insert(media).values({
    id: mediaId,
    ownerProfileId: null,
    status: 'processing',
    originalKey: key,
    contentType: photo.contentType,
    byteSize: photo.body.length,
    sourceUrl,
  });
  try {
    await processUploadedMedia(db, storage, mediaId);
  } catch (error) {
    if (!(error instanceof ImageRejectedError)) {
      await db.update(media).set({ deletedAt: new Date() }).where(eq(media.id, mediaId));
      throw error;
    }
    await markMediaFailed(db, mediaId, error.message);
    return { outcome: 'refused', reason: error.message };
  }

  await db.transaction(async (tx) => {
    // Only if the shop photo is still the one copied (a newer read may have changed it).
    const [swapped] = await tx
      .update(products)
      .set({ imageMediaId: mediaId, embedding: null, embeddingModel: null })
      .where(and(eq(products.id, productId), eq(products.imageUrl, sourceUrl)))
      .returning({ id: products.id });
    // The photo no longer shown: the old copy, or this one if the shop photo changed meanwhile.
    const unused = swapped ? product.photoId : mediaId;
    if (unused) {
      await tx
        .update(media)
        .set({ deletedAt: sql`now()` })
        .where(and(eq(media.id, unused), isNull(media.ownerProfileId)));
    }
  });
  return { outcome: 'copied', mediaId };
}

/** Worth trying again later: the shop's server was down, slow or busy (429 / 503), not refusing. */
export function retryable(error: LinkFetchError): boolean {
  if (error.problem === 'unreachable' || error.problem === 'too_slow') return true;
  return error.problem === 'blocked' && (error.httpStatus === 429 || error.httpStatus === 503);
}

export type ProductFingerprintOutcome =
  { outcome: 'done'; model: string } | { outcome: 'skipped'; reason: string };

/** Fingerprints a product's copied photo (the whole photo). Throws `EmbedderError`. */
export async function fingerprintProduct(
  deps: ProductPhotoDeps,
  productId: string,
): Promise<ProductFingerprintOutcome> {
  const { db, embedder } = deps;
  if (!embedder) return { outcome: 'skipped', reason: 'no fingerprint service' };
  const [product] = await db
    .select({
      photoId: media.id,
      key1080: media.key1080,
      status: media.status,
      hasFingerprint: sql<boolean>`${products.embedding} is not null`,
    })
    .from(products)
    .innerJoin(media, eq(media.id, products.imageMediaId))
    .where(and(eq(products.id, productId), isNull(products.deletedAt)));
  if (!product || product.status !== 'ready' || !product.key1080) {
    return { outcome: 'skipped', reason: 'photo not ready' };
  }
  if (product.hasFingerprint) return { outcome: 'skipped', reason: 'already fingerprinted' };
  const answer = await embedder.embedImage(deps.storage.publicUrl(product.key1080), [
    { left: 0, top: 0, right: 1, bottom: 1 },
  ]);
  const [embedding] = answer.embeddings;
  if (!embedding) return { outcome: 'skipped', reason: 'no fingerprint returned' };
  // Only if it still shows the photo that was fingerprinted.
  await db
    .update(products)
    .set({ embedding, embeddingModel: answer.model })
    .where(and(eq(products.id, productId), eq(products.imageMediaId, product.photoId)));
  return { outcome: 'done', model: answer.model };
}
