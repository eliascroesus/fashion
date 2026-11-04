import { randomUUID } from 'node:crypto';
import rateLimit from '@fastify/rate-limit';
import type { Db } from '@outfitly/db';
import { API_PREFIX } from '@outfitly/shared';
import Fastify, { type FastifyInstance, type FastifyServerOptions } from 'fastify';
import type { JWTVerifyGetKey } from 'jose';
import { registerAuth } from './auth.ts';
import type { Config } from './config.ts';
import { ApiError, notFoundHandler, registerErrorHandler } from './errors.ts';
import { registerIdempotency } from './idempotency.ts';
import type { JobQueue } from './jobs.ts';
import { boardsRoutes } from './routes/boards.ts';
import { eventsRoutes } from './routes/events.ts';
import { feedRoutes } from './routes/feed.ts';
import { looksRoutes } from './routes/looks.ts';
import { profilesRoutes } from './routes/profiles.ts';
import { tasteRoutes } from './routes/taste.ts';
import { mediaRoutes } from './routes/media.ts';
import { savesRoutes } from './routes/saves.ts';
import { searchRoutes } from './routes/search.ts';
import { sessionRoutes } from './routes/session.ts';
import { systemRoutes } from './routes/system.ts';
import type { PhotoStorage } from './storage.ts';
import { registerZod } from './zod.ts';

export interface AppDeps {
  config: Config;
  db: Db;
  /** Supabase signing keys; tests pass local ones. */
  jwks: JWTVerifyGetKey;
  storage: PhotoStorage;
  queue: JobQueue;
  logger?: FastifyServerOptions['logger'];
}

/** Builds the API without starting it, so tests can call it in-process. */
export async function buildApp(deps: AppDeps): Promise<FastifyInstance> {
  const { config, db, jwks, logger } = deps;
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
  registerErrorHandler(app);
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
  app.setNotFoundHandler({ preHandler: app.rateLimit() }, notFoundHandler);
  const auth = { supabaseUrl: config.SUPABASE_URL, jwks };
  registerAuth(app, auth);
  registerIdempotency(app, { db });

  await app.register(
    (v1, _opts, done) => {
      systemRoutes(v1);
      sessionRoutes(v1, { db, auth });
      mediaRoutes(v1, deps);
      feedRoutes(v1, deps);
      eventsRoutes(v1, deps);
      savesRoutes(v1, deps);
      boardsRoutes(v1, deps);
      looksRoutes(v1, deps);
      tasteRoutes(v1, deps);
      searchRoutes(v1, deps);
      profilesRoutes(v1, deps);
      done();
    },
    { prefix: API_PREFIX },
  );
  return app;
}
