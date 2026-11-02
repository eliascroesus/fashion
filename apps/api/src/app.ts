import { randomUUID } from 'node:crypto';
import rateLimit from '@fastify/rate-limit';
import type { Db } from '@outfitly/db';
import { API_PREFIX } from '@outfitly/shared';
import Fastify, { type FastifyInstance, type FastifyServerOptions } from 'fastify';
import type { JWTVerifyGetKey } from 'jose';
import { registerAuth } from './auth.ts';
import type { Config } from './config.ts';
import { ApiError, registerErrorHandlers } from './errors.ts';
import { registerIdempotency } from './idempotency.ts';
import { systemRoutes } from './routes/system.ts';
import { registerZod } from './zod.ts';

export interface AppDeps {
  config: Config;
  db: Db;
  /** Supabase signing keys; tests pass local ones. */
  jwks: JWTVerifyGetKey;
  logger?: FastifyServerOptions['logger'];
}

/** Builds the API without starting it, so tests can call it in-process. */
export async function buildApp({ config, db, jwks, logger }: AppDeps): Promise<FastifyInstance> {
  const behindFly = Boolean(config.FLY_APP_NAME);
  const app = Fastify({
    logger: logger ?? {
      level: config.LOG_LEVEL,
      redact: ['req.headers.authorization', 'req.headers.cookie'],
    },
    genReqId: () => randomUUID(),
    requestIdHeader: false,
    trustProxy: behindFly,
    bodyLimit: 1024 * 1024,
  });

  registerZod(app);
  registerErrorHandlers(app);
  app.addHook('onSend', async (request, reply) => {
    void reply.header('x-request-id', request.id);
  });

  await app.register(rateLimit, {
    max: config.RATE_LIMIT_PER_MINUTE,
    timeWindow: '1 minute',
    // On Fly.io the proxy sets Fly-Client-IP; elsewhere a client could fake it.
    keyGenerator: (request) => {
      const flyIp = request.headers['fly-client-ip'];
      return behindFly && typeof flyIp === 'string' ? flyIp : request.ip;
    },
    errorResponseBuilder: (_request, context) =>
      new ApiError(429, 'rate_limited', `Too many requests. Try again in ${context.after}.`),
  });
  registerAuth(app, { supabaseUrl: config.SUPABASE_URL, jwks });
  registerIdempotency(app, { db });

  await app.register(
    (v1, _opts, done) => {
      systemRoutes(v1);
      done();
    },
    { prefix: API_PREFIX },
  );
  return app;
}
