import {
  feedPageSchema,
  popularTagsSchema,
  searchQuerySchema,
  suggestionsSchema,
  suggestQuerySchema,
} from '@outfitly/shared';
import type { FastifyInstance } from 'fastify';
import { findActiveProfile } from '../profiles.ts';
import { popularTags, type SearchDeps, searchLooks, suggest } from '../search.ts';
import type { ZodTypeProvider } from '../zod.ts';

/**
 * Search (public, like For You): results (by words and, when the fingerprint
 * service answers, by how the words look), suggestions while typing, popular tags.
 */
export function searchRoutes(app: FastifyInstance, deps: SearchDeps): void {
  const routes = app.withTypeProvider<ZodTypeProvider>();

  routes.get(
    '/search/looks',
    {
      config: { public: true },
      schema: { querystring: searchQuerySchema, response: { 200: feedPageSchema } },
    },
    async (request) => {
      const viewer = await findActiveProfile(deps.db, request);
      return searchLooks(deps, viewer, request.query.q, request.query.cursor);
    },
  );

  routes.get(
    '/search/suggest',
    {
      config: { public: true },
      schema: { querystring: suggestQuerySchema, response: { 200: suggestionsSchema } },
    },
    async (request) => suggest(deps, request.query.q),
  );

  routes.get(
    '/search/popular',
    { config: { public: true }, schema: { response: { 200: popularTagsSchema } } },
    async () => popularTags(deps.db),
  );
}
