import type { Db } from '@outfitly/db';
import { clickBatchInputSchema, clickBatchResultSchema } from '@outfitly/shared';
import type { FastifyInstance } from 'fastify';
import { readableClicks, recordClicks } from '../clicks.ts';
import { findActiveProfile } from '../profiles.ts';
import type { ZodTypeProvider } from '../zod.ts';

/** Batches per minute per IP. The app sends each tap at once, so this is about taps per minute. */
export const CLICKS_PER_MINUTE = { loggedIn: 30, loggedOut: 20 } as const;

/**
 * Taps on Shop. The app keeps each click on the phone before it opens the
 * shop and sends it in the background (at once, or later when offline).
 */
export function clicksRoutes(app: FastifyInstance, { db }: { db: Db }): void {
  const routes = app.withTypeProvider<ZodTypeProvider>();

  routes.post(
    '/clicks',
    {
      // Logged-out visitors shop too. Each click carries its own id, so a resent
      // batch is skipped by the database without an Idempotency-Key row per batch.
      config: {
        public: true,
        dedupedByIds: true,
        // After the login check (preValidation), so logged-out callers get the lower limit.
        rateLimit: {
          hook: 'preValidation',
          max: (request) =>
            request.auth ? CLICKS_PER_MINUTE.loggedIn : CLICKS_PER_MINUTE.loggedOut,
          timeWindow: '1 minute',
        },
      },
      bodyLimit: 16 * 1024,
      schema: { body: clickBatchInputSchema, response: { 200: clickBatchResultSchema } },
    },
    async (request) => {
      const profileId = await findActiveProfile(db, request);
      const clicks = readableClicks(request.body.clicks);
      if (clicks.length === 0) return { accepted: 0 };
      return { accepted: await recordClicks(db, profileId, { ...request.body, clicks }) };
    },
  );
}
