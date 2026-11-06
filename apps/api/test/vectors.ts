import { type Db, sql } from '@outfitly/db';
import { FINGERPRINT_DIMENSIONS } from '@outfitly/shared';

/**
 * A unit fingerprint `degrees` away from axis `from` towards axis `to`: its
 * cosine to axis `from` is cos(degrees), so a bigger angle is less similar.
 */
export function angled(degrees: number, from = 0, to = 1): number[] {
  const v = new Array<number>(FINGERPRINT_DIMENSIONS).fill(0);
  const radians = (degrees * Math.PI) / 180;
  v[from] = Math.cos(radians);
  v[to] = Math.sin(radians);
  return v;
}

/** A fingerprint as a halfvec literal for raw SQL (`${…}::extensions.halfvec`). */
export const vectorText = (vector: readonly number[]) => `[${vector.join(',')}]`;

/**
 * Test fingerprints point along axes: many are exactly at right angles (ties
 * everywhere), which an HNSW graph can't find its way through, so the index
 * would miss neighbours real fingerprints never lose. Tests of the ranking
 * rules drop the indexes in their own database and get exact nearest ones;
 * fingerprint-index.test.ts checks the index on realistic fingerprints.
 */
export async function dropFingerprintIndexes(db: Db): Promise<void> {
  await db.execute(
    sql`DROP INDEX media_embedding_idx, products_embedding_idx, garments_embedding_idx`,
  );
}
