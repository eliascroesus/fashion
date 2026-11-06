import { z } from 'zod';
import { type Style, STYLES } from './looks.ts';

/** `?cursor=` from the previous page's `nextCursor`; leave it out for the first page. */
export const feedQuerySchema = z.object({
  cursor: z.string().min(1).max(200).optional(),
});
export type FeedQuery = z.infer<typeof feedQuerySchema>;

/** Known styles in STYLES order, each once (also how a taste is compared and keyed). */
export function knownStyles(values: readonly string[]): Style[] {
  const set = new Set(values);
  return STYLES.filter((style) => set.has(style));
}

/** The phone's taste-picker styles as For You's `?styles=` (undefined when there are none). */
export function stylesParam(styles: readonly Style[]): string | undefined {
  const known = knownStyles(styles);
  return known.length > 0 ? known.join(',') : undefined;
}

/**
 * For You also takes `?styles=` (comma list): the taste picked on the phone,
 * used while the profile has none stored (logged out, or before it's uploaded).
 * Unknown values are dropped, so an old phone never gets an error.
 */
export const forYouQuerySchema = feedQuerySchema.extend({
  styles: z
    .string()
    .max(200)
    .optional()
    .transform((value) => knownStyles(value?.split(',') ?? [])),
});
export type ForYouQuery = z.infer<typeof forYouQuerySchema>;

/** One card in a feed grid: the cover photo, sized up front so the grid never jumps. */
export const feedCardSchema = z.object({
  id: z.uuid(),
  authorId: z.uuid(),
  photo: z.object({
    width: z.number().int().positive(),
    height: z.number().int().positive(),
    thumbhash: z.string(),
    dominantColor: z.string(),
    urls: z.object({ 1080: z.url(), 600: z.url(), 300: z.url() }),
  }),
  /** Shoppable pieces in the look (its verified shop links, at most MAX_LOOK_ITEMS). */
  itemCount: z.number().int().nonnegative(),
  /** Whether the profile asking has saved it (false when logged out). */
  saved: z.boolean(),
});
export type FeedCard = z.infer<typeof feedCardSchema>;

/** A page of a feed (FEED_PAGE_SIZE cards). `nextCursor` is null at the end. */
export const feedPageSchema = z.object({
  items: z.array(feedCardSchema),
  nextCursor: z.string().nullable(),
});
export type FeedPage = z.infer<typeof feedPageSchema>;
