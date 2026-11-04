/** What a look is for. Stored as tags on the look; labels live in the app's i18n files. */
export const OCCASIONS = [
  'everyday',
  'work',
  'date',
  'party',
  'wedding',
  'travel',
  'sport',
  'festival',
] as const;
export type Occasion = (typeof OCCASIONS)[number];

export const SEASONS = ['spring', 'summer', 'autumn', 'winter'] as const;
export type Season = (typeof SEASONS)[number];

/**
 * A look's style (usually one); also the taste picker's style chips. What each
 * means is in docs/STYLE_GUIDE.md. The ids are permanent: the database enum and
 * answers waiting on phones use them, so add new ones but never rename.
 */
export const STYLES = [
  'minimal',
  'streetwear',
  'classic',
  'sporty',
  'romantic',
  'edgy',
  'colorful',
] as const;
export type Style = (typeof STYLES)[number];

/** Every tag a look can carry: occasions, seasons and styles share one list for people writing seed files. */
export const LOOK_TAGS = [...OCCASIONS, ...SEASONS, ...STYLES] as const;
export type LookTag = Occasion | Season | Style;

export const LOOK_STATUSES = ['draft', 'pending', 'published', 'hidden'] as const;
export type LookStatus = (typeof LOOK_STATUSES)[number];

/** A look has 1 to this many photos. */
export const MAX_LOOK_PHOTOS = 10;

/** Things we count in the `events` table. */
export const EVENT_NAMES = ['impression', 'open', 'save', 'share', 'click'] as const;
export type EventName = (typeof EVENT_NAMES)[number];

/** Sorts mixed tags into occasions, seasons and styles (duplicates dropped). */
export function splitLookTags(tags: readonly LookTag[]): {
  occasions: Occasion[];
  seasons: Season[];
  styles: Style[];
} {
  const set = new Set(tags);
  return {
    occasions: OCCASIONS.filter((o) => set.has(o)),
    seasons: SEASONS.filter((s) => set.has(s)),
    styles: STYLES.filter((s) => set.has(s)),
  };
}

const SLUG_TEXT_MAX = 60;
const SLUG_ID_CHARS = 12;
/** Letters that Unicode normalisation doesn't split into a base letter + accent. */
const LETTER_FOLDS: Record<string, string> = { ß: 'ss', æ: 'ae', ø: 'o', œ: 'oe', đ: 'd', ł: 'l' };

/**
 * The look's public URL part, e.g. `camel-coat-over-a-grey-knit-3f9a2c1b4d5e`.
 * Readable text from the caption plus part of the id, so it is unique.
 */
export function lookSlug(caption: string | null | undefined, id: string): string {
  const text = (caption ?? '')
    .toLowerCase()
    .normalize('NFKD')
    .replace(/\p{M}/gu, '')
    .replace(/[ßæøœđł]/g, (c) => LETTER_FOLDS[c] ?? '')
    .replace(/[^a-z0-9]+/g, '-')
    .slice(0, SLUG_TEXT_MAX)
    .replace(/^-+|-+$/g, '');
  const suffix = id.replace(/-/g, '').slice(0, SLUG_ID_CHARS).toLowerCase();
  return `${text || 'look'}-${suffix}`;
}
