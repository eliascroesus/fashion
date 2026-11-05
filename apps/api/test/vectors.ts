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
