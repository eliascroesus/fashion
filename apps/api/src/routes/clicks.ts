import type { Db } from '@outfitly/db';
import { clickBatchResultSchema, clickBatchSchema } from '@outfitly/shared';
import type { FastifyInstance } from 'fastify';
import { recordClicks } from '../clicks.ts';
import { findActiveProfile } from '../profiles.ts';
import type { ZodTypeProvider } from '../zod.ts';

/** Batches per minute per IP. The app sends each tap at once, so this is taps per minute. */
export const CLICKS_PER_MINUTE = { loggedIn: 30, loggedOut: 20 } as const;

/** Taps on Shop, sent by the app after the shop has opened. */
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
      schema: { body: clickBatchSchema, response: { 200: clickBatchResultSchema } },
    },
    async (request) => {
      const profileId = await findActiveProfile(db, request);
      return { accepted: await recordClicks(db, profileId, request.body) };
    },
  );
}
