import {
  boardBodySchema,
  boardDeletedSchema,
  boardItemStateSchema,
  boardListQuerySchema,
  boardListSchema,
  boardSchema,
  feedPageSchema,
  feedQuerySchema,
} from '@outfitly/shared';
import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import type { FeedDeps } from '../feed/cards.ts';
import { requireActiveProfile } from '../profiles.ts';
import {
  addToBoard,
  boardLooksPage,
  createBoard,
  deleteBoard,
  listBoards,
  removeFromBoard,
  renameBoard,
} from '../saves.ts';
import type { ZodTypeProvider } from '../zod.ts';

const boardParams = z.object({ boardId: z.uuid() });
const itemParams = z.object({ boardId: z.uuid(), lookId: z.uuid() });

/** The active profile's boards and the looks on them. */
export function boardsRoutes(app: FastifyInstance, deps: FeedDeps): void {
  const routes = app.withTypeProvider<ZodTypeProvider>();
  const { db } = deps;

  routes.get(
    '/boards',
    { schema: { querystring: boardListQuerySchema, response: { 200: boardListSchema } } },
    async (request) => {
      const profileId = await requireActiveProfile(db, request);
      return { items: await listBoards(deps, profileId, request.query.lookId) };
    },
  );

  routes.post(
    '/boards',
    { schema: { body: boardBodySchema, response: { 201: boardSchema } } },
    async (request, reply) => {
      const profileId = await requireActiveProfile(db, request);
      return reply.status(201).send(await createBoard(deps, profileId, request.body.name));
    },
  );

  routes.patch(
    '/boards/:boardId',
    { schema: { params: boardParams, body: boardBodySchema, response: { 200: boardSchema } } },
    async (request) => {
      const profileId = await requireActiveProfile(db, request);
      return renameBoard(deps, profileId, request.params.boardId, request.body.name);
    },
  );

  routes.delete(
    '/boards/:boardId',
    { schema: { params: boardParams, response: { 200: boardDeletedSchema } } },
    async (request) => {
      const profileId = await requireActiveProfile(db, request);
      await deleteBoard(db, profileId, request.params.boardId);
      return { id: request.params.boardId, deleted: true as const };
    },
  );

  routes.get(
    '/boards/:boardId/looks',
    {
      schema: {
        params: boardParams,
        querystring: feedQuerySchema,
        response: { 200: feedPageSchema },
      },
    },
    async (request) => {
      const profileId = await requireActiveProfile(db, request);
      return boardLooksPage(deps, profileId, request.params.boardId, request.query.cursor);
    },
  );

  routes.put(
    '/boards/:boardId/looks/:lookId',
    { schema: { params: itemParams, body: z.object({}), response: { 200: boardItemStateSchema } } },
    async (request) => {
      const profileId = await requireActiveProfile(db, request);
      const { boardId, lookId } = request.params;
      await addToBoard(db, profileId, boardId, lookId);
      return { boardId, lookId, inBoard: true };
    },
  );

  routes.delete(
    '/boards/:boardId/looks/:lookId',
    { schema: { params: itemParams, response: { 200: boardItemStateSchema } } },
    async (request) => {
      const profileId = await requireActiveProfile(db, request);
      const { boardId, lookId } = request.params;
      await removeFromBoard(db, profileId, boardId, lookId);
      return { boardId, lookId, inBoard: false };
    },
  );
}
