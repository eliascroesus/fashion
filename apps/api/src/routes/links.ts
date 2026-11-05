import { resolvedLinkSchema, resolveLinkBodySchema } from '@outfitly/shared';
import type { FastifyInstance } from 'fastify';
import { type LinkDeps, resolveLink } from '../links/resolve.ts';
import { requireActiveProfile } from '../profiles.ts';
import type { ZodTypeProvider } from '../zod.ts';

/**
 * Reading a shop page takes our server out to someone else's: limited per
 * login (all its profiles together), on top of the per-phone limit.
 */
const RESOLVES_PER_MINUTE = 20;

/** Paste a shop link, get the product and offer (Step 3.4). */
export function linksRoutes(app: FastifyInstance, deps: LinkDeps): void {
  const routes = app.withTypeProvider<ZodTypeProvider>();

  routes.post(
    '/links/resolve',
    {
      config: {
        // After the login check (preParsing), so the limit can be per login.
        rateLimit: {
          hook: 'preValidation',
          max: RESOLVES_PER_MINUTE,
          timeWindow: '1 minute',
          keyGenerator: (request) => `links:${request.auth?.userId ?? request.ip}`,
        },
      },
      schema: { body: resolveLinkBodySchema, response: { 200: resolvedLinkSchema } },
    },
    async (request) => {
      const profileId = await requireActiveProfile(deps.db, request);
      return resolveLink(deps, profileId, request.body.url);
    },
  );
}
