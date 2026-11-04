import { z } from 'zod';

/** Where in the app an event happened (`events.source`). */
export const EVENT_SOURCES = ['feed_for_you', 'feed_following', 'search', 'profile'] as const;
export type EventSource = (typeof EVENT_SOURCES)[number];

export const CLIENT_PLATFORMS = ['ios', 'android', 'web'] as const;
export type ClientPlatform = (typeof CLIENT_PLATFORMS)[number];

/** The app sends events in batches of at most this many. */
export const MAX_EVENT_BATCH = 50;

/**
 * One thing that happened on a phone. `id` is made on the phone, so a batch
 * sent twice is stored once. Only impressions so far: a card at least half
 * on screen for a second, with its place in the feed.
 */
export const clientEventSchema = z.object({
  id: z.uuid(),
  name: z.literal('impression'),
  lookId: z.uuid(),
  /** 0-based place in the feed. */
  position: z.number().int().min(0).max(10_000),
  source: z.enum(EVENT_SOURCES),
  occurredAt: z.iso.datetime(),
});
export type ClientEvent = z.infer<typeof clientEventSchema>;

/** `POST /v1/events`. Works logged out: `sessionId` is a random id kept on the phone. */
export const eventBatchSchema = z.object({
  sessionId: z.uuid(),
  platform: z.enum(CLIENT_PLATFORMS),
  events: z.array(clientEventSchema).min(1).max(MAX_EVENT_BATCH),
});
export type EventBatch = z.infer<typeof eventBatchSchema>;

/** How many of the batch's events were new and stored (repeats and unknown looks are skipped). */
export const eventBatchResultSchema = z.object({ accepted: z.number().int().nonnegative() });
export type EventBatchResult = z.infer<typeof eventBatchResultSchema>;
