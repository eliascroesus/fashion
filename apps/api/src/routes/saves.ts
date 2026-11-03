import {
  feedPageSchema,
  feedQuerySchema,
  saveStateSchema,
  swipeBodySchema,
  swipeStateSchema,
} from '@outfitly/shared';
import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import type { FeedDeps } from '../feed/cards.ts';
import { requireActiveProfile } from '../profiles.ts';
import { saveLook, savesPage, seeLess, unsaveLook } from '../saves.ts';
import type { ZodTypeProvider } from '../zod.ts';

const lookParams = z.object({ lookId: z.uuid() });

/** Saving looks and "see less like this", as the active profile. */
export function savesRoutes(app: FastifyInstance, deps: FeedDeps): void {
  const routes = app.withTypeProvider<ZodTypeProvider>();
  const { db } = deps;

  routes.get(
    '/saves',
    { schema: { querystring: feedQuerySchema, response: { 200: feedPageSchema } } },
    async (request) => {
      const profileId = await requireActiveProfile(db, request);
      return savesPage(deps, profileId, request.query.cursor);
    },
  );

  routes.put(
    '/saves/:lookId',
    { schema: { params: lookParams, body: z.object({}), response: { 200: saveStateSchema } } },
    async (request) => {
      const profileId = await requireActiveProfile(db, request);
      await saveLook(db, profileId, request.params.lookId);
      return { lookId: request.params.lookId, saved: true };
    },
  );

  routes.delete(
    '/saves/:lookId',
    { schema: { params: lookParams, response: { 200: saveStateSchema } } },
    async (request) => {
      const profileId = await requireActiveProfile(db, request);
      await unsaveLook(db, profileId, request.params.lookId);
      return { lookId: request.params.lookId, saved: false };
    },
  );

  routes.put(
    '/swipes/:lookId',
    { schema: { params: lookParams, body: swipeBodySchema, response: { 200: swipeStateSchema } } },
    async (request) => {
      const profileId = await requireActiveProfile(db, request);
      await seeLess(db, profileId, request.params.lookId);
      return { lookId: request.params.lookId, kind: request.body.kind };
    },
  );
}
