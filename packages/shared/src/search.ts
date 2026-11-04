import { z } from 'zod';
import { feedQuerySchema } from './feed.ts';
import { lookAuthorSchema } from './look-page.ts';
import { LOOK_TAGS, type LookTag } from './looks.ts';

/** Search text is at most this long. */
export const MAX_SEARCH_LENGTH = 100;
/** Only the first words of a search are used. */
export const MAX_SEARCH_WORDS = 6;
/** A longer "word" is cut here (nothing real is longer; keeps queries small). */
const MAX_WORD_LENGTH = 40;

/**
 * More words that find a tag (its id finds it too): its labels in the app's
 * languages where they differ from the id, plus a few everyday synonyms. The
 * app's tests check every tag label is here. Lowercase.
 */
export const TAG_SEARCH_WORDS: Record<LookTag, readonly string[]> = {
  everyday: ['vardag'],
  work: ['jobb'],
  date: ['dejt'],
  party: ['fest'],
  wedding: ['bröllop'],
  travel: ['resa'],
  sport: ['träning'],
  festival: [],
  spring: ['vår'],
  summer: ['sommar'],
  autumn: ['fall', 'höst'],
  winter: ['vinter'],
  minimal: ['minimalistisk'],
  streetwear: [],
  classic: ['klassisk'],
  sporty: ['sportig'],
  romantic: ['romantisk'],
  edgy: [],
  colorful: ['colourful', 'färgglad'],
};

/**
 * Small words that don't narrow a search (English and Swedish). Left out of
 * searches and never suggested.
 */
export const STOP_WORDS: ReadonlySet<string> = new Set([
  'a',
  'an',
  'and',
  'as',
  'at',
  'by',
  'for',
  'from',
  'in',
  'into',
  'of',
  'on',
  'or',
  'over',
  'the',
  'to',
  'under',
  'with',
  'av',
  'en',
  'ett',
  'eller',
  'för',
  'i',
  'med',
  'och',
  'på',
  'som',
  'till',
]);

/**
 * The words of a search: lowercase letters (with their accent marks) and
 * digits in any language, each once, at most MAX_SEARCH_WORDS. Small words
 * are left out unless the search is nothing but those.
 */
export function searchWords(text: string): string[] {
  const all = text
    .normalize('NFC')
    .toLowerCase()
    .match(/[\p{L}\p{M}\p{N}]+/gu);
  const unique = [...new Set((all ?? []).map((w) => w.slice(0, MAX_WORD_LENGTH)))];
  const meaningful = unique.filter((w) => !STOP_WORDS.has(w));
  return (meaningful.length > 0 ? meaningful : unique).slice(0, MAX_SEARCH_WORDS);
}

/**
 * Search text: control characters (which Postgres text can't hold, e.g. NUL)
 * become spaces, then trimmed; 1–100 characters.
 */
const searchText = z
  .string()
  // eslint-disable-next-line no-control-regex
  .transform((text) => text.replace(/[\u0000-\u001f\u007f]/g, ' ').trim())
  .pipe(z.string().min(1).max(MAX_SEARCH_LENGTH));

/** `GET /v1/search/looks?q=&cursor=`: looks matching the words, 20 per page. */
export const searchQuerySchema = feedQuerySchema.extend({ q: searchText });
export type SearchQuery = z.infer<typeof searchQuerySchema>;

/** `GET /v1/search/suggest?q=`: what someone is typing. */
export const suggestQuerySchema = z.object({ q: searchText });

/** Someone who posts, as search suggestions show them. */
export const profileBriefSchema = lookAuthorSchema.omit({ isFollowing: true });
export type ProfileBrief = z.infer<typeof profileBriefSchema>;

/**
 * Suggestions while typing: whole searches (the last word completed, earlier
 * words kept) and people whose handle or name matches.
 */
export const suggestionsSchema = z.object({
  terms: z.array(z.string()),
  profiles: z.array(profileBriefSchema),
});
export type Suggestions = z.infer<typeof suggestionsSchema>;

/** `GET /v1/search/popular`: the tags most looks carry, most first (the app labels them). */
export const popularTagsSchema = z.object({ tags: z.array(z.enum(LOOK_TAGS)) });
export type PopularTags = z.infer<typeof popularTagsSchema>;
