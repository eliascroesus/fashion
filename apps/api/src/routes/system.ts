import { healthSchema } from '@outfitly/shared';
import type { FastifyInstance } from 'fastify';
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
}
