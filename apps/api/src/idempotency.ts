import { createHash } from 'node:crypto';
import { and, type Db, eq, idempotencyKeys, lt, or, sql } from '@outfitly/db';
import {
  IDEMPOTENCY_KEY_HEADER,
  IDEMPOTENCY_KEY_PATTERN,
  IDEMPOTENT_REPLAY_HEADER,
} from '@outfitly/shared';
import type { FastifyInstance, FastifyRequest } from 'fastify';
import { ApiError } from './errors.ts';

declare module 'fastify' {
  interface FastifyRequest {
    /** Row this request claimed in `idempotency_keys`; its response gets stored there. */
    idempotencyKeyId: string | null;
  }
}

const WRITE_METHODS = new Set(['POST', 'PUT', 'PATCH', 'DELETE']);
/** An unfinished claim older than this is treated as a crashed request and can be retried. */
const STALE_AFTER = sql`now() - interval '60 seconds'`;

function requestHash(request: FastifyRequest): string {
  return createHash('sha256')
    .update(`${request.method} ${request.url}\n${JSON.stringify(request.body ?? null)}`)
    .digest('hex');
}

/**
 * Every logged-in write must carry an Idempotency-Key header. The first
 * request with a key does the work and its response is stored; repeats get
 * the stored response, so a double-tap or network retry never duplicates.
 */
export function registerIdempotency(app: FastifyInstance, { db }: { db: Db }): void {
  app.decorateRequest('idempotencyKeyId', null);

  app.addHook('preHandler', async (request, reply) => {
    if (!WRITE_METHODS.has(request.method) || !request.auth) return;

    const key = request.headers[IDEMPOTENCY_KEY_HEADER];
    if (typeof key !== 'string' || !IDEMPOTENCY_KEY_PATTERN.test(key)) {
      throw new ApiError(
        400,
        'idempotency_key_required',
        'Writes need an Idempotency-Key header (8–255 letters, digits, - or _).',
      );
    }
    const { userId } = request.auth;
    const hash = requestHash(request);
    const thisKey = and(eq(idempotencyKeys.userId, userId), eq(idempotencyKeys.key, key));

    const [claimed] = await db
      .insert(idempotencyKeys)
      .values({ userId, key, requestHash: hash })
      .onConflictDoNothing()
      .returning({ id: idempotencyKeys.id });
    if (claimed) {
      request.idempotencyKeyId = claimed.id;
      return;
    }

    // Reuse the row if it has expired, or if the same request crashed midway.
    const [reclaimed] = await db
      .update(idempotencyKeys)
      .set({
        requestHash: hash,
        status: 'in_progress',
        responseStatus: null,
        responseBody: null,
        expiresAt: sql`now() + interval '24 hours'`,
      })
      .where(
        and(
          thisKey,
          or(
            lt(idempotencyKeys.expiresAt, sql`now()`),
            and(
              eq(idempotencyKeys.status, 'in_progress'),
              eq(idempotencyKeys.requestHash, hash),
              lt(idempotencyKeys.updatedAt, STALE_AFTER),
            ),
          ),
        ),
      )
      .returning({ id: idempotencyKeys.id });
    if (reclaimed) {
      request.idempotencyKeyId = reclaimed.id;
      return;
    }

    const [existing] = await db.select().from(idempotencyKeys).where(thisKey);
    if (existing && existing.requestHash !== hash) {
      throw new ApiError(
        422,
        'idempotency_key_reused',
        'This Idempotency-Key was already used for a different request.',
      );
    }
    if (!existing || existing.status === 'in_progress' || existing.responseStatus === null) {
      void reply.header('retry-after', '1');
      throw new ApiError(409, 'idempotency_in_progress', 'This request is still being processed.');
    }
    return reply
      .status(existing.responseStatus)
      .header(IDEMPOTENT_REPLAY_HEADER, 'true')
      .header('content-type', 'application/json; charset=utf-8')
      .send(existing.responseBody);
  });

  app.addHook('onSend', async (request, reply, payload) => {
    const id = request.idempotencyKeyId;
    if (!id) return payload;
    request.idempotencyKeyId = null;

    if (reply.statusCode >= 500 || typeof payload !== 'string') {
      // Nothing worth replaying: free the key so the client can retry.
      await db.delete(idempotencyKeys).where(eq(idempotencyKeys.id, id));
    } else {
      await db
        .update(idempotencyKeys)
        .set({ status: 'completed', responseStatus: reply.statusCode, responseBody: payload })
        .where(eq(idempotencyKeys.id, id));
    }
    return payload;
  });
}
