import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { requireAuth } from '../auth.ts';
import type { ZodTypeProvider } from '../zod.ts';

export function systemRoutes(app: FastifyInstance): void {
  const routes = app.withTypeProvider<ZodTypeProvider>();

  routes.get(
    '/health',
    {
      config: { public: true, rateLimit: false },
      schema: { response: { 200: z.object({ status: z.literal('ok') }) } },
    },
    () => ({ status: 'ok' as const }),
  );

  routes.get(
    '/me',
    {
      schema: {
        response: { 200: z.object({ userId: z.uuid(), isAnonymous: z.boolean() }) },
      },
    },
    (request) => requireAuth(request),
  );
}
