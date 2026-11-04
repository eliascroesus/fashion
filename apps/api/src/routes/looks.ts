import {
  feedPageSchema,
  feedQuerySchema,
  followStateSchema,
  lookDetailSchema,
} from '@outfitly/shared';
import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import type { FeedDeps } from '../feed/cards.ts';
import { follow, unfollow } from '../follows.ts';
import { lookDetail, similarPage } from '../looks.ts';
import { findActiveProfile, requireActiveProfile } from '../profiles.ts';
import type { ZodTypeProvider } from '../zod.ts';

const lookParams = z.object({ lookId: z.uuid() });
const profileParams = z.object({ profileId: z.uuid() });

/** The look page (public, like For You) and following the people who post. */
export function looksRoutes(app: FastifyInstance, deps: FeedDeps): void {
  const routes = app.withTypeProvider<ZodTypeProvider>();
  const { db } = deps;

  routes.get(
    '/looks/:lookId',
    {
      config: { public: true },
      schema: { params: lookParams, response: { 200: lookDetailSchema } },
    },
    async (request) => {
      const viewer = await findActiveProfile(db, request);
      return lookDetail(deps, viewer, request.params.lookId);
    },
  );

  routes.get(
    '/looks/:lookId/similar',
    {
      config: { public: true },
      schema: {
        params: lookParams,
        querystring: feedQuerySchema,
        response: { 200: feedPageSchema },
      },
    },
    async (request) => {
      const viewer = await findActiveProfile(db, request);
      return similarPage(deps, viewer, request.params.lookId, request.query.cursor);
    },
  );

  routes.put(
    '/follows/:profileId',
    {
      schema: { params: profileParams, body: z.object({}), response: { 200: followStateSchema } },
    },
    async (request) => {
      const profileId = await requireActiveProfile(db, request);
      await follow(db, profileId, request.params.profileId);
      return { profileId: request.params.profileId, following: true };
    },
  );

  routes.delete(
    '/follows/:profileId',
    { schema: { params: profileParams, response: { 200: followStateSchema } } },
    async (request) => {
      const profileId = await requireActiveProfile(db, request);
      await unfollow(db, profileId, request.params.profileId);
      return { profileId: request.params.profileId, following: false };
    },
  );
}
