import { z } from 'zod';

/** `?cursor=` from the previous page's `nextCursor`; leave it out for the first page. */
export const feedQuerySchema = z.object({
  cursor: z.string().min(1).max(200).optional(),
});
export type FeedQuery = z.infer<typeof feedQuerySchema>;

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
  /** Shoppable pieces in the look (0 until products exist, Phase 3). */
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
