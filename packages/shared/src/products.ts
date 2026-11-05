/**
 * What kind of piece a garment or product is. The AI picks one per garment
 * (Step 3.3) and "similar pieces" only compares within one. Ordered as a
 * look's item list reads: outerwear first, accessories last. Labels live in
 * the app's i18n files. The ids are permanent (database enum): add new ones
 * but never rename.
 */
export const GARMENT_CATEGORIES = [
  'coat',
  'jacket',
  'blazer',
  /** Jumpers and cardigans. */
  'knitwear',
  /** Sweatshirts and hoodies. */
  'sweatshirt',
  'shirt',
  't_shirt',
  /** Blouses, tanks, bodies and other tops. */
  'top',
  'dress',
  /** Jumpsuits and playsuits. */
  'jumpsuit',
  'trousers',
  'jeans',
  'skirt',
  'shorts',
  'swimwear',
  'sneakers',
  'boots',
  'heels',
  /** Loafers, ballet flats and other flat shoes. */
  'flats',
  'sandals',
  'bag',
  'hat',
  'sunglasses',
  'scarf',
  'jewelry',
  'watch',
  'belt',
  /** Anything else: gloves, ties, hair clips… */
  'accessory',
] as const;
export type GarmentCategory = (typeof GARMENT_CATEGORIES)[number];

/**
 * Length of a fingerprint (image or text) from Marqo-FashionSigLIP: its
 * `open_clip_config.json` says `"embed_dim": 768` (ViT-B-16-SigLIP). Compared
 * by cosine similarity, as in the model card's examples.
 */
export const FINGERPRINT_DIMENSIONS = 768;

/** A garment's pattern as the AI reads it (Step 3.3). Stored in `garments.attributes`. */
export const GARMENT_PATTERNS = [
  'solid',
  'striped',
  'checked',
  'floral',
  'dotted',
  'animal',
  'graphic',
  'other',
] as const;
export type GarmentPattern = (typeof GARMENT_PATTERNS)[number];

/**
 * Why the AI held a photo back (Step 3.3): its look is hidden and queued for
 * review. `blocked` means Gemini refused to read the photo at all.
 */
export const SAFETY_FLAGS = ['nudity', 'violence', 'spam_text', 'blocked'] as const;
export type SafetyFlag = (typeof SAFETY_FLAGS)[number];
