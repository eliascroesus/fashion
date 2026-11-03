import { feedPageSchema, feedQuerySchema } from '@outfitly/shared';
import type { FastifyInstance } from 'fastify';
import type { FeedDeps } from '../feed/cards.ts';
import { followingPage } from '../feed/following.ts';
import { forYouPage } from '../feed/for-you.ts';
import { findActiveProfile, requireActiveProfile } from '../profiles.ts';
import type { ZodTypeProvider } from '../zod.ts';

const schema = { querystring: feedQuerySchema, response: { 200: feedPageSchema } };

/** The home feeds, 20 looks per page with a cursor. */
export function feedRoutes(app: FastifyInstance, deps: FeedDeps): void {
  const routes = app.withTypeProvider<ZodTypeProvider>();

  // Public: people browse before they have a login (a guest one starts at the first save).
  // A login without a profile yet gets the logged-out feed rather than an error.
  routes.get('/feed/for-you', { config: { public: true }, schema }, async (request) => {
    const profileId = await findActiveProfile(deps.db, request);
    return forYouPage(deps, profileId, request.query.cursor);
  });

  routes.get('/feed/following', { schema }, async (request) => {
    const profileId = await requireActiveProfile(deps.db, request);
    return followingPage(deps, profileId, request.query.cursor);
  });
}
