import { eq, idempotencyKeys, sql } from '@outfitly/db';
import { apiErrorSchema } from '@outfitly/shared';
import type { FastifyInstance } from 'fastify';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { z } from 'zod';
import type { ZodTypeProvider } from '../src/zod.ts';
import { buildTestApp, createTestContext, signToken, type TestContext } from './helpers.ts';

let ctx: TestContext;
let app: FastifyInstance;
let calls = 0;
let failNext = false;
let releaseSlow: (() => void) | null = null;

beforeAll(async () => {
  ctx = await createTestContext();
  app = await buildTestApp(ctx);
  // A write that counts how often it really runs.
  app.withTypeProvider<ZodTypeProvider>().post(
    '/v1/test/counter',
    {
      schema: {
        body: z.object({ amount: z.number().int() }),
        response: { 201: z.object({ call: z.number(), amount: z.number() }) },
      },
    },
    async (request, reply) => {
      calls += 1;
      if (failNext) {
        failNext = false;
        throw new Error('database hiccup');
      }
      if (request.body.amount === 999) {
        await new Promise<void>((resolve) => (releaseSlow = resolve));
      }
      return reply.status(201).send({ call: calls, amount: request.body.amount });
    },
  );
  // A write that answers with no body, like unfollow or unsave.
  app.delete(
    '/v1/test/counter',
    { schema: { response: { 204: z.null() } } },
    async (_request, reply) => {
      calls += 1;
      return reply.status(204).send();
    },
  );
  await app.ready();
});

afterAll(async () => {
  await app.close();
  await ctx.close();
});

beforeEach(() => {
  calls = 0;
});

async function post(key: string | undefined, amount: number, token?: string) {
  return app.inject({
    method: 'POST',
    url: '/v1/test/counter',
    headers: {
      authorization: `Bearer ${token ?? (await signToken({ sub: USER }))}`,
      ...(key === undefined ? {} : { 'idempotency-key': key }),
    },
    payload: { amount },
  });
}

const USER = crypto.randomUUID();

describe('idempotency keys', () => {
  it('are required on logged-in writes', async () => {
    const missing = await post(undefined, 1);
    expect(missing.statusCode).toBe(400);
    expect(apiErrorSchema.parse(missing.json()).error.code).toBe('idempotency_key_required');

    const tooShort = await post('abc', 1);
    expect(tooShort.statusCode).toBe(400);
    expect(calls).toBe(0);
  });

  it('replay the first response for a retried request, doing the work once', async () => {
    const key = crypto.randomUUID();
    const first = await post(key, 5);
    const retry = await post(key, 5);
    expect(first.statusCode).toBe(201);
    expect(retry.statusCode).toBe(201);
    expect(retry.json()).toEqual(first.json());
    expect(retry.headers['idempotent-replayed']).toBe('true');
    expect(first.headers['idempotent-replayed']).toBeUndefined();
    expect(calls).toBe(1);
  });

  it('refuse the same key for a different request', async () => {
    const key = crypto.randomUUID();
    await post(key, 1);
    const res = await post(key, 2);
    expect(res.statusCode).toBe(422);
    expect(apiErrorSchema.parse(res.json()).error.code).toBe('idempotency_key_reused');
    expect(calls).toBe(1);
  });

  it('answer 409 while the first request is still running (double-tap)', async () => {
    const key = crypto.randomUUID();
    const slow = post(key, 999);
    await expect.poll(() => releaseSlow).not.toBeNull();
    const second = await post(key, 999);
    expect(second.statusCode).toBe(409);
    expect(second.headers['retry-after']).toBe('1');
    expect(apiErrorSchema.parse(second.json()).error.code).toBe('idempotency_in_progress');
    releaseSlow?.();
    releaseSlow = null;
    expect((await slow).statusCode).toBe(201);
    expect(calls).toBe(1);
  });

  it('let a request that failed on our side be retried with the same key', async () => {
    const key = crypto.randomUUID();
    failNext = true;
    const failed = await post(key, 3);
    expect(failed.statusCode).toBe(500);
    const retry = await post(key, 3);
    expect(retry.statusCode).toBe(201);
    expect(calls).toBe(2);
  });

  it('let a crashed request be retried after a minute', async () => {
    const key = crypto.randomUUID();
    await post(key, 4);
    // Simulate a crash mid-request: claim left in progress, a minute ago.
    await ctx.db
      .update(idempotencyKeys)
      .set({ status: 'in_progress', updatedAt: sql`now() - interval '2 minutes'` })
      .where(eq(idempotencyKeys.key, key));
    const retry = await post(key, 4);
    expect(retry.statusCode).toBe(201);
    expect(calls).toBe(2);
  });

  it('are scoped to the login, so two people can use the same key', async () => {
    const key = crypto.randomUUID();
    await post(key, 1, await signToken());
    const other = await post(key, 1, await signToken());
    expect(other.statusCode).toBe(201);
    expect(other.headers['idempotent-replayed']).toBeUndefined();
    expect(calls).toBe(2);
  });

  it('also protect writes that answer with no body (204)', async () => {
    const key = crypto.randomUUID();
    const send = async () =>
      app.inject({
        method: 'DELETE',
        url: '/v1/test/counter',
        headers: {
          authorization: `Bearer ${await signToken({ sub: USER })}`,
          'idempotency-key': key,
        },
      });
    const first = await send();
    const retry = await send();
    expect([first.statusCode, retry.statusCode]).toEqual([204, 204]);
    expect(retry.headers['idempotent-replayed']).toBe('true');
    expect(retry.body).toBe('');
    expect(calls).toBe(1);
  });

  it('let unknown routes answer 404 instead of asking for a key', async () => {
    const res = await app.inject({
      method: 'POST',
      url: '/v1/nope',
      headers: { authorization: `Bearer ${await signToken({ sub: USER })}` },
      payload: {},
    });
    expect(res.statusCode).toBe(404);
  });

  it('are not needed for reads', async () => {
    const res = await app.inject({
      method: 'GET',
      url: '/v1/me',
      headers: { authorization: `Bearer ${await signToken()}` },
    });
    expect(res.statusCode).toBe(200);
  });
});
