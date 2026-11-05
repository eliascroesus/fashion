import { z } from 'zod';
import { CLIENT_PLATFORMS, EVENT_SOURCES, MAX_FEED_POSITION } from './events.ts';

/**
 * Where the look was opened from before Shop was tapped (`clicks.source`):
 * the lists impressions come from, plus the app's other grids. With
 * `position` it says which card of which list led to the shop.
 * `similar_pieces`: Shop on a piece in "similar pieces" (the click's look is
 * the look that piece's shop link is on; `position` its place in that list).
 */
export const CLICK_SOURCES = [...EVENT_SOURCES, 'saved', 'board', 'similar_pieces'] as const;
export type ClickSource = (typeof CLICK_SOURCES)[number];

/** The app sends clicks in batches of at most this many. */
export const MAX_CLICK_BATCH = 20;

/**
 * One tap on Shop. `id` is the click id: made on the phone at the tap and
 * kept with the click while it waits to be sent, so a click sent twice is
 * stored once. Later it's the id passed to shops for commissions.
 */
export const clientClickSchema = z.object({
  id: z.uuid(),
  lookId: z.uuid(),
  offerId: z.uuid(),
  /** The list the look was opened from; null when it wasn't opened from one (e.g. a link). */
  source: z.enum(CLICK_SOURCES).nullable(),
  /** 0-based place of the look's card in that list. */
  position: z.number().int().min(0).max(MAX_FEED_POSITION).nullable(),
  /** When Shop was tapped, by the phone's clock (a click can wait on the phone while offline). */
  tappedAt: z.iso.datetime(),
});
export type ClientClick = z.infer<typeof clientClickSchema>;

/** `POST /v1/clicks`. Works logged out: `sessionId` is the same install id events send. */
export const clickBatchSchema = z.object({
  sessionId: z.uuid(),
  platform: z.enum(CLIENT_PLATFORMS),
  clicks: z.array(clientClickSchema).min(1).max(MAX_CLICK_BATCH),
});
export type ClickBatch = z.infer<typeof clickBatchSchema>;

/**
 * What the server accepts: the same batch, but each click is checked on its
 * own, so one it can't read is skipped instead of refusing (and the app then
 * dropping) the whole batch.
 */
export const clickBatchInputSchema = clickBatchSchema.extend({
  clicks: z.array(z.unknown()).min(1).max(MAX_CLICK_BATCH),
});

/** How many of the batch's clicks were new and stored (repeats and unknown pieces are skipped). */
export const clickBatchResultSchema = z.object({ accepted: z.number().int().nonnegative() });
export type ClickBatchResult = z.infer<typeof clickBatchResultSchema>;
