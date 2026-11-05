import sharp from 'sharp';
import { z } from 'zod';
import type { Box } from '../ai/spot.ts';

/**
 * The link check's question to Gemini (Step 3.5): is the piece in the look's
 * photo the shop's product? Asked only when the fingerprints are neither
 * clearly alike nor clearly different. Change the prompt or schema → bump
 * the version.
 */
export const COMPARE_PROMPT_VERSION = 'link-check-v1';

/** A yes/no/unsure and one short sentence (with room for a little thinking); caps a runaway answer's cost. */
export const COMPARE_MAX_OUTPUT_TOKENS = 512;

/** Longest side of each photo sent: enough to tell two pieces apart, fewer tokens. */
const SIDE = 512;
/** Room around the garment's box, as a share of its size: boxes are tight. */
const MARGIN = 0.06;

export const COMPARE_PROMPT = `Photo A is one piece of an outfit, cropped from a photo someone posted in a fashion app. Photo B is the product photo from the shop page they linked to it.

Is the piece in photo A the same product as in photo B: the same item from the same brand, in the same colour? Photos differ (worn versus laid flat, light, angle, folds); judge the item itself: its shape, cut, colour, pattern, material and details such as buttons, pockets, collar, stitching, logos and soles.

- same: "yes" if it is clearly the same product; "no" if it is clearly a different product, or the same kind of item in a different colour or pattern; "unsure" if the photos don't show enough to tell.
- reason: one short sentence (at most 20 words) on what decided it.`;

export const COMPARE_SCHEMA = {
  type: 'object',
  properties: {
    same: { type: 'string', enum: ['yes', 'no', 'unsure'] },
    reason: { type: 'string' },
  },
  required: ['same', 'reason'],
} as const;

export interface CompareAnswer {
  same: 'yes' | 'no' | 'unsure';
  reason: string | null;
}

const answerShape = z.object({ same: z.enum(['yes', 'no', 'unsure']), reason: z.string() });

/** Gemini's JSON as an answer, or null when it isn't the promised shape. */
export function parseCompareAnswer(text: string): CompareAnswer | null {
  let json: unknown;
  try {
    json = JSON.parse(text);
  } catch {
    return null;
  }
  const answer = answerShape.safeParse(json);
  if (!answer.success) return null;
  const reason = answer.data.reason.replace(/\s+/g, ' ').trim().slice(0, 200);
  return { same: answer.data.same, reason: reason === '' ? null : reason };
}

/**
 * The garment cut out of our own processed photo (with a little room around
 * the box), at most 512 px on its longest side, as WebP.
 */
export async function garmentCrop(photo: Buffer, box: Box): Promise<Buffer> {
  const image = sharp(photo, { failOn: 'error' });
  const { width, height } = await image.metadata();
  if (width === 0 || height === 0) throw new Error('Photo has no size.');
  const padX = (box.right - box.left) * MARGIN;
  const padY = (box.bottom - box.top) * MARGIN;
  const left = Math.max(0, Math.floor((box.left - padX) * width));
  const top = Math.max(0, Math.floor((box.top - padY) * height));
  const right = Math.min(width, Math.ceil((box.right + padX) * width));
  const bottom = Math.min(height, Math.ceil((box.bottom + padY) * height));
  return image
    .extract({
      left,
      top,
      width: Math.max(1, right - left),
      height: Math.max(1, bottom - top),
    })
    .resize(SIDE, SIDE, { fit: 'inside', withoutEnlargement: true })
    .webp({ quality: 85 })
    .toBuffer();
}

/** A product photo at most 512 px on its longest side, as WebP. */
export async function smallPhoto(photo: Buffer): Promise<Buffer> {
  return sharp(photo, { failOn: 'error' })
    .resize(SIDE, SIDE, { fit: 'inside', withoutEnlargement: true })
    .webp({ quality: 85 })
    .toBuffer();
}
