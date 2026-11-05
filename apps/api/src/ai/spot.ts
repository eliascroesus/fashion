import {
  GARMENT_CATEGORIES,
  GARMENT_PATTERNS,
  type GarmentCategory,
  type SafetyFlag,
} from '@outfitly/shared';
import { z } from 'zod';

/**
 * Garment spotting: what we ask Gemini about a look's photo, and how its
 * answer becomes rows. Change the prompt or schema → bump the version, so the
 * log shows which answers came from which.
 */
export const SPOT_PROMPT_VERSION = 'spot-v2';

/** More than this is noise (or a shop shelf); the rest is dropped. */
export const MAX_GARMENTS = 20;
export const MAX_TAGS = 12;
/** Room for 20 garments, the sentence and the tags; also caps a runaway answer's cost. */
export const SPOT_MAX_OUTPUT_TOKENS = 4096;

export const SPOT_PROMPT = `This photo is from a fashion app where people share outfits and shop the pieces.

List every clearly visible piece of the outfit: clothes, shoes, bags and accessories worn or carried by the person, or laid out as one outfit. One entry per piece; never list a piece twice. Skip pieces that are mostly hidden or cut off, and anything that isn't part of the outfit (furniture, shop shelves, other people in the background).

For each piece:
- category: the closest one from the list. Hoodies are "sweatshirt", jumpers and cardigans "knitwear", blouses and tank tops "top", loafers and ballet flats "flats".
- color: the main colour in one or two plain English words, e.g. "beige", "navy", "light blue".
- pattern: one of the listed patterns.
- material: your best guess in one word (denim, leather, wool, knit, cotton, linen, silk, satin, suede, synthetic), or "unknown".
- brand_text: brand name or logo text you can actually read on the piece; an empty string if none. Never guess a brand from the style.
- box_2d: the tight box around the piece as [ymin, xmin, ymax, xmax], normalised to 0-1000.

Then for the whole photo:
- description: one sentence of at most 25 words describing the outfit for search, without brand guesses.
- tags: 3 to 10 short lowercase English search words (style, pieces, colours, occasion, season), e.g. "minimal", "trench coat", "beige".
- safety: nudity = nudity or sexual content; violence = graphic violence, gore or weapons; spam_text = advertising text added on top of the photo (prices, discount codes, phone numbers, web addresses). Logos on clothes and signs in the background are not spam.

If no outfit is visible, return an empty garments list.`;

/**
 * The answer's shape (Gemini `responseJsonSchema`). Gemini answers 400 "invalid argument" when a
 * format has too many limits (measured 2026-11-05 on gemini-3.1-flash-lite: these enums plus
 * number bounds plus list caps was one too many), so counts and box values are only checked on
 * our side (`parseSpotAnswer`, `boxFromGemini`).
 */
export const SPOT_SCHEMA = {
  type: 'object',
  properties: {
    garments: {
      type: 'array',
      items: {
        type: 'object',
        properties: {
          category: { type: 'string', enum: [...GARMENT_CATEGORIES] },
          color: { type: 'string' },
          pattern: { type: 'string', enum: [...GARMENT_PATTERNS] },
          material: { type: 'string' },
          brand_text: { type: 'string' },
          box_2d: {
            type: 'array',
            description: 'The box as [ymin, xmin, ymax, xmax] normalized to 0-1000.',
            items: { type: 'integer' },
            minItems: 4,
            maxItems: 4,
          },
        },
        required: ['category', 'color', 'pattern', 'material', 'brand_text', 'box_2d'],
      },
    },
    description: { type: 'string' },
    tags: { type: 'array', items: { type: 'string' } },
    safety: {
      type: 'object',
      properties: {
        nudity: { type: 'boolean' },
        violence: { type: 'boolean' },
        spam_text: { type: 'boolean' },
      },
      required: ['nudity', 'violence', 'spam_text'],
    },
  },
  required: ['garments', 'description', 'tags', 'safety'],
} as const;

/** In fractions of the photo, like the `garments` table: 0 = left/top edge, 1 = right/bottom. */
export interface Box {
  left: number;
  top: number;
  right: number;
  bottom: number;
}

export interface SpottedGarment {
  category: GarmentCategory;
  color: string | null;
  attributes: { pattern?: string; material?: string; brandText?: string };
  box: Box;
}

export interface SpotResult {
  garments: SpottedGarment[];
  description: string | null;
  tags: string[];
  flags: SafetyFlag[];
}

/** Below this share of the photo's width or height a box is a speck, not a piece. */
const MIN_BOX_SIDE = 0.01;

/**
 * Gemini's `[ymin, xmin, ymax, xmax]` (0–1000) as fractions, clamped to the
 * photo, with swapped corners put right. Null when nothing usable is left.
 */
export function boxFromGemini(box2d: readonly number[]): Box | null {
  if (box2d.length !== 4 || !box2d.every((n) => Number.isFinite(n))) return null;
  const clamp = (n: number) => Math.min(1, Math.max(0, n / 1000));
  const [y1, x1, y2, x2] = box2d.map(clamp) as [number, number, number, number];
  const box = {
    left: Math.min(x1, x2),
    top: Math.min(y1, y2),
    right: Math.max(x1, x2),
    bottom: Math.max(y1, y2),
  };
  if (box.right - box.left < MIN_BOX_SIDE || box.bottom - box.top < MIN_BOX_SIDE) return null;
  return box;
}

/** Lowercase, single spaces, letters/digits/spaces/hyphens only; empty → null. */
function word(value: string, maxLength: number): string | null {
  const cleaned = value
    .toLowerCase()
    .replace(/[^\p{L}\p{N}\s-]/gu, ' ')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, maxLength)
    .trim();
  return cleaned === '' || cleaned === 'unknown' || cleaned === 'none' ? null : cleaned;
}

function sentence(value: string, maxLength: number): string | null {
  const cleaned = value.replace(/\s+/g, ' ').trim();
  if (cleaned === '') return null;
  if (cleaned.length <= maxLength) return cleaned;
  const cut = cleaned.slice(0, maxLength);
  return `${cut.slice(0, Math.max(cut.lastIndexOf(' '), 1)).trim()}…`;
}

const garmentShape = z.object({
  category: z.enum(GARMENT_CATEGORIES),
  color: z.string(),
  pattern: z.string(),
  material: z.string(),
  brand_text: z.string(),
  box_2d: z.array(z.number()),
});

const answerShape = z.object({
  garments: z.array(z.unknown()),
  description: z.string(),
  tags: z.array(z.unknown()),
  safety: z.object({ nudity: z.boolean(), violence: z.boolean(), spam_text: z.boolean() }),
});

/**
 * Turns Gemini's JSON into rows. A piece that doesn't fit (unknown category,
 * bad box) is dropped on its own; null only when the answer as a whole is
 * unusable.
 */
export function parseSpotAnswer(text: string): SpotResult | null {
  let json: unknown;
  try {
    json = JSON.parse(text);
  } catch {
    return null;
  }
  const answer = answerShape.safeParse(json);
  if (!answer.success) return null;
  const { garments, description, tags, safety } = answer.data;

  const spotted: SpottedGarment[] = [];
  for (const item of garments) {
    if (spotted.length >= MAX_GARMENTS) break;
    const garment = garmentShape.safeParse(item);
    if (!garment.success) continue;
    const box = boxFromGemini(garment.data.box_2d);
    if (!box) continue;
    const pattern = word(garment.data.pattern, 20);
    const material = word(garment.data.material, 30);
    const brandText = sentence(garment.data.brand_text, 60);
    spotted.push({
      category: garment.data.category,
      color: word(garment.data.color, 40),
      attributes: {
        ...(pattern && (GARMENT_PATTERNS as readonly string[]).includes(pattern)
          ? { pattern }
          : {}),
        ...(material ? { material } : {}),
        ...(brandText ? { brandText } : {}),
      },
      box,
    });
  }

  const cleanTags: string[] = [];
  for (const tag of tags) {
    if (typeof tag !== 'string') continue;
    const cleaned = word(tag, 40);
    if (cleaned && !cleanTags.includes(cleaned)) cleanTags.push(cleaned);
    if (cleanTags.length >= MAX_TAGS) break;
  }

  const flags: SafetyFlag[] = [];
  if (safety.nudity) flags.push('nudity');
  if (safety.violence) flags.push('violence');
  if (safety.spam_text) flags.push('spam_text');

  return { garments: spotted, description: sentence(description, 300), tags: cleanTags, flags };
}
