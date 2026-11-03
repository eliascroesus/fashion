import type { Db } from '@outfitly/db';
import { eventBatchResultSchema, eventBatchSchema } from '@outfitly/shared';
import type { FastifyInstance } from 'fastify';
import { recordEvents } from '../events.ts';
import { findActiveProfile } from '../profiles.ts';
import type { ZodTypeProvider } from '../zod.ts';

/** What the app saw and did (impressions so far), sent in batches. */
export function eventsRoutes(app: FastifyInstance, { db }: { db: Db }): void {
  const routes = app.withTypeProvider<ZodTypeProvider>();

  routes.post(
    '/events',
    {
      // Logged-out visitors browse too. Each event carries its own id, so a resent
      // batch is skipped by the database without an Idempotency-Key row per batch.
      config: { public: true, dedupedByIds: true, rateLimit: { max: 60, timeWindow: '1 minute' } },
      bodyLimit: 64 * 1024,
      schema: { body: eventBatchSchema, response: { 200: eventBatchResultSchema } },
    },
    async (request) => {
      const profileId = await findActiveProfile(db, request);
      return { accepted: await recordEvents(db, profileId, request.body) };
    },
  );
}
