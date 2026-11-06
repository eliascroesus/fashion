import type { Db } from '@outfitly/db';
import { eventBatchInputSchema, eventBatchResultSchema } from '@outfitly/shared';
import type { FastifyInstance } from 'fastify';
import { readableEvents, recordEvents } from '../events.ts';
import { findActiveProfile } from '../profiles.ts';
import type { ZodTypeProvider } from '../zod.ts';

/** Batches per minute per IP. */
export const EVENTS_PER_MINUTE = { loggedIn: 60, loggedOut: 20 } as const;

/** What the app saw and did (impressions so far), sent in batches. */
export function eventsRoutes(app: FastifyInstance, { db }: { db: Db }): void {
  const routes = app.withTypeProvider<ZodTypeProvider>();

  routes.post(
    '/events',
    {
      // Logged-out visitors browse too. Each event carries its own id, so a resent
      // batch is skipped by the database without an Idempotency-Key row per batch.
      config: {
        public: true,
        dedupedByIds: true,
        // After the login check (preValidation), so logged-out callers get the lower limit.
        // The app sends a batch every 10 s at most while scrolling.
        rateLimit: {
          hook: 'preValidation',
          max: (request) =>
            request.auth ? EVENTS_PER_MINUTE.loggedIn : EVENTS_PER_MINUTE.loggedOut,
          timeWindow: '1 minute',
        },
      },
      bodyLimit: 64 * 1024,
      schema: { body: eventBatchInputSchema, response: { 200: eventBatchResultSchema } },
    },
    async (request) => {
      const profileId = await findActiveProfile(db, request);
      const events = readableEvents(request.body.events);
      if (events.length === 0) return { accepted: 0 };
      return { accepted: await recordEvents(db, profileId, { ...request.body, events }) };
    },
  );
}
