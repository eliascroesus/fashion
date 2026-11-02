import { healthSchema, meSchema } from '@outfitly/shared';
import type { FastifyInstance } from 'fastify';
import { requireAuth } from '../auth.ts';
import type { ZodTypeProvider } from '../zod.ts';

export function systemRoutes(app: FastifyInstance): void {
  const routes = app.withTypeProvider<ZodTypeProvider>();

  routes.get(
    '/health',
    {
      config: { public: true, rateLimit: false },
      schema: { response: { 200: healthSchema } },
    },
    () => ({ status: 'ok' as const }),
  );

  routes.get(
    '/me',
    {
      schema: { response: { 200: meSchema } },
    },
    (request) => requireAuth(request),
  );
}
