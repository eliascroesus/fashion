// The link check's numbers from labelled pairs (`pnpm links:calibrate --file pairs.csv`).
import { type Thresholds, thresholdsSchema } from '../../src/links/check.ts';

export interface LabelledPair {
  garmentId: string;
  productId: string;
  /** A person said it's the same product. */
  same: boolean;
  /** Cosine similarity of the two fingerprints. */
  similarity: number;
  /** The AI's answer, when it was asked (`--ai`, pairs in the middle only). */
  ai?: 'yes' | 'no' | 'unsure' | null;
}

export interface ThresholdRow {
  verifyAt: number;
  rejectBelow: number;
  /** Different items the check would verify (fingerprint alone, plus the AI's yes when known). */
  wrongVerified: number;
  wrongVerifiedShare: number;
  /** Same items the check would reject. */
  rightRejected: number;
  rightRejectedShare: number;
  /** Pairs in between, which the AI is asked about. */
  toAi: number;
  toAiShare: number;
  /** Pairs in between the AI wasn't sure about (go to a person), when it was asked. */
  toReview: number;
}

/** The Done-when goal: fewer than this share of wrong items is auto-verified, on at least 100 pairs. */
export const MAX_WRONG_VERIFIED = 0.05;
export const MIN_LABELLED_PAIRS = 100;
/** Fewer than these and a suggestion would be noise. */
const MIN_DIFFERENT_TO_SUGGEST = 30;
const MIN_SAME_TO_SUGGEST = 10;
/** The fingerprint alone may let through at most this, leaving room for the AI's own mistakes. */
const FINGERPRINT_BUDGET = 0.02;
/** At most this share of good links may be rejected without the AI looking. */
const MAX_RIGHT_REJECTED = 0.05;

const share = (part: number, whole: number) => (whole === 0 ? 0 : part / whole);

/** What the check would do with these pairs at these thresholds. */
export function evaluate(
  pairs: LabelledPair[],
  verifyAt: number,
  rejectBelow: number,
): ThresholdRow {
  const different = pairs.filter((p) => !p.same);
  const same = pairs.filter((p) => p.same);
  const middle = (p: LabelledPair) => p.similarity >= rejectBelow && p.similarity < verifyAt;
  const wrongVerified = different.filter(
    (p) => p.similarity >= verifyAt || (middle(p) && p.ai === 'yes'),
  ).length;
  const rightRejected = same.filter(
    (p) => p.similarity < rejectBelow || (middle(p) && p.ai === 'no'),
  ).length;
  const toAi = pairs.filter(middle).length;
  return {
    verifyAt,
    rejectBelow,
    wrongVerified,
    wrongVerifiedShare: share(wrongVerified, different.length),
    rightRejected,
    rightRejectedShare: share(rightRejected, same.length),
    toAi,
    toAiShare: share(toAi, pairs.length),
    toReview: pairs.filter((p) => middle(p) && p.ai === 'unsure').length,
  };
}

/**
 * Suggested thresholds: the lowest `verifyAt` where the fingerprint alone
 * verifies at most 2% of different items (the AI gets the rest of the 5%),
 * and the highest `rejectBelow` that rejects at most 5% of same items.
 */
export function suggest(pairs: LabelledPair[]): Thresholds | null {
  const different = pairs.filter((p) => !p.same);
  const same = pairs.filter((p) => p.same);
  if (different.length < MIN_DIFFERENT_TO_SUGGEST || same.length < MIN_SAME_TO_SUGGEST) return null;
  // In hundredths, so the steps add up exactly.
  let verifyAt = 100;
  for (let v = 99; v >= 30; v--) {
    const through = different.filter((p) => p.similarity >= v / 100).length;
    if (share(through, different.length) > FINGERPRINT_BUDGET) break;
    verifyAt = v;
  }
  let rejectBelow = 0;
  for (let r = 0; r < verifyAt; r++) {
    const lost = same.filter((p) => p.similarity < r / 100).length;
    if (share(lost, same.length) > MAX_RIGHT_REJECTED) break;
    rejectBelow = r;
  }
  // Within what the check accepts (verifyAt at least 0.5).
  return thresholdsSchema.parse({
    verifyAt: Math.max(verifyAt, 50) / 100,
    rejectBelow: Math.min(rejectBelow, Math.max(verifyAt, 50) - 1) / 100,
  });
}

/** `garment_id,product_id,same` lines (yes/no; a header and # comments are fine). */
export function parsePairsCsv(
  text: string,
): { garmentId: string; productId: string; same: boolean }[] {
  const uuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
  const pairs: { garmentId: string; productId: string; same: boolean }[] = [];
  for (const [i, raw] of text.split(/\r?\n/).entries()) {
    const line = raw.replace(/#.*$/, '').trim();
    if (line === '' || /^garment/i.test(line)) continue;
    const [garmentId = '', productId = '', label = ''] = line.split(',').map((c) => c.trim());
    const same = label.toLowerCase();
    if (!uuid.test(garmentId) || !uuid.test(productId) || (same !== 'yes' && same !== 'no')) {
      throw new Error(`Line ${String(i + 1)} isn't "garment_id,product_id,yes|no": ${raw}`);
    }
    pairs.push({ garmentId, productId, same: same === 'yes' });
  }
  return pairs;
}

/** `--set <verifyAt> <rejectBelow>`: two plain numbers the check accepts, else an error. */
export function parseThresholdArgs(
  verifyAt: string | undefined,
  rejectBelow: string | undefined,
): Thresholds {
  const number = /^\d+(\.\d+)?$/;
  if (!verifyAt || !rejectBelow || !number.test(verifyAt) || !number.test(rejectBelow)) {
    throw new Error('Use --set <verifyAt> <rejectBelow>, e.g. --set 0.85 0.6.');
  }
  const parsed = thresholdsSchema.safeParse({
    verifyAt: Number(verifyAt),
    rejectBelow: Number(rejectBelow),
  });
  if (!parsed.success) {
    throw new Error(
      'verifyAt must be from 0.5 to 1, and rejectBelow from 0 up to (not including) verifyAt.',
    );
  }
  return parsed.data;
}
