import { feedPageSchema, feedQuerySchema, profilePageSchema } from '@outfitly/shared';
import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import type { FeedDeps } from '../feed/cards.ts';
import { profileLooksPage, profilePage } from '../profile-page.ts';
import { findActiveProfile } from '../profiles.ts';
import type { ZodTypeProvider } from '../zod.ts';

const profileParams = z.object({ profileId: z.uuid() });

/** Profile screens (public): the top part with counts, and the profile's looks. */
export function profilesRoutes(app: FastifyInstance, deps: FeedDeps): void {
  const routes = app.withTypeProvider<ZodTypeProvider>();

  routes.get(
    '/profiles/:profileId',
    {
      config: { public: true },
      schema: { params: profileParams, response: { 200: profilePageSchema } },
    },
    async (request) => {
      const viewer = await findActiveProfile(deps.db, request);
      return profilePage(deps, viewer, request.params.profileId);
    },
  );

  routes.get(
    '/profiles/:profileId/looks',
    {
      config: { public: true },
      schema: {
        params: profileParams,
        querystring: feedQuerySchema,
        response: { 200: feedPageSchema },
      },
    },
    async (request) => {
      const viewer = await findActiveProfile(deps.db, request);
      return profileLooksPage(deps, viewer, request.params.profileId, request.query.cursor);
    },
  );
}
