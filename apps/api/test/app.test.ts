import { apiErrorSchema } from '@outfitly/shared';
import type { FastifyInstance } from 'fastify';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { z } from 'zod';
import { buildTestApp, createTestContext, signToken, type TestContext } from './helpers.ts';

let ctx: TestContext;
let app: FastifyInstance;

beforeAll(async () => {
  ctx = await createTestContext();
  app = await buildTestApp(ctx);
  // Extra routes that exist only in tests, to exercise validation and errors.
  app.post(
    '/v1/test/echo',
    {
      schema: {
        body: z.object({ name: z.string().min(2), age: z.number().int() }),
        response: { 200: z.object({ name: z.string(), age: z.number() }) },
      },
    },
    (request) => request.body,
  );
  app.get('/v1/test/crash', { schema: { response: { 200: z.object({}) } } }, () => {
    throw new Error('secret database detail');
  });
  app.get(
    '/v1/test/bad-response',
    { schema: { response: { 200: z.object({ ok: z.literal(true) }) } } },
    () => ({ ok: false }),
  );
  await app.ready();
});

afterAll(async () => {
  await app.close();
  await ctx.close();
});

describe('GET /v1/health', () => {
  it('returns ok without a login, with a request id', async () => {
    const res = await app.inject({ method: 'GET', url: '/v1/health' });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({ status: 'ok' });
    expect(res.headers['x-request-id']).toMatch(/^[0-9a-f-]{36}$/);
  });
});

describe('login check', () => {
  it('returns 401 in the standard error format without a login', async () => {
    const res = await app.inject({ method: 'GET', url: '/v1/me' });
    expect(res.statusCode).toBe(401);
    const body = apiErrorSchema.parse(res.json());
    expect(body.error.code).toBe('unauthorized');
    expect(body.error.requestId).toBe(res.headers['x-request-id']);
  });

  it('accepts a Supabase login token', async () => {
    const sub = crypto.randomUUID();
    const res = await app.inject({
      method: 'GET',
      url: '/v1/me',
      headers: { authorization: `Bearer ${await signToken({ sub })}` },
    });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({ userId: sub, isAnonymous: false });
  });

  it('accepts an anonymous (guest) Supabase token', async () => {
    const res = await app.inject({
      method: 'GET',
      url: '/v1/me',
      headers: { authorization: `Bearer ${await signToken({ isAnonymous: true })}` },
    });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toMatchObject({ isAnonymous: true });
  });

  it.each([
    ['expired', { expiresIn: '-1m' }],
    ['from another project', { issuer: 'https://other.supabase.co/auth/v1' }],
    ['for another audience', { audience: 'anon' }],
    ['with the wrong role', { role: 'service_role' }],
    ['with a non-UUID subject', { sub: 'not-a-uuid' }],
  ])('rejects a token %s', async (_label, options) => {
    const res = await app.inject({
      method: 'GET',
      url: '/v1/me',
      headers: { authorization: `Bearer ${await signToken(options)}` },
    });
    expect(res.statusCode).toBe(401);
    expect(apiErrorSchema.parse(res.json()).error.code).toBe('unauthorized');
  });

  it('rejects a token signed with a different key', async () => {
    const [header, payload] = (await signToken()).split('.');
    const forged = `${String(header)}.${String(payload)}.${'A'.repeat(86)}`;
    const res = await app.inject({
      method: 'GET',
      url: '/v1/me',
      headers: { authorization: `Bearer ${forged}` },
    });
    expect(res.statusCode).toBe(401);
  });

  it('rejects a malformed Authorization header', async () => {
    const res = await app.inject({
      method: 'GET',
      url: '/v1/me',
      headers: { authorization: 'Basic abc' },
    });
    expect(res.statusCode).toBe(401);
  });
});

describe('error format', () => {
  it('answers unknown routes with 404 not_found', async () => {
    const res = await app.inject({ method: 'GET', url: '/v1/nope' });
    expect(res.statusCode).toBe(404);
    expect(apiErrorSchema.parse(res.json()).error.code).toBe('not_found');
  });

  it('answers invalid input with 400 validation_failed and the problems', async () => {
    const res = await app.inject({
      method: 'POST',
      url: '/v1/test/echo',
      headers: {
        authorization: `Bearer ${await signToken()}`,
        'idempotency-key': crypto.randomUUID(),
      },
      payload: { name: 'x', age: 'old' },
    });
    expect(res.statusCode).toBe(400);
    const body = apiErrorSchema.parse(res.json());
    expect(body.error.code).toBe('validation_failed');
    expect(body.error.details).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ path: 'name' }),
        expect.objectContaining({ path: 'age' }),
      ]),
    );
  });

  it('answers malformed JSON with 400 validation_failed', async () => {
    const res = await app.inject({
      method: 'POST',
      url: '/v1/test/echo',
      headers: {
        authorization: `Bearer ${await signToken()}`,
        'idempotency-key': crypto.randomUUID(),
        'content-type': 'application/json',
      },
      payload: '{"name":',
    });
    expect(res.statusCode).toBe(400);
    expect(apiErrorSchema.parse(res.json()).error.code).toBe('validation_failed');
  });

  it('hides internal details of unexpected errors behind 500 internal_error', async () => {
    const res = await app.inject({
      method: 'GET',
      url: '/v1/test/crash',
      headers: { authorization: `Bearer ${await signToken()}` },
    });
    expect(res.statusCode).toBe(500);
    expect(apiErrorSchema.parse(res.json()).error.code).toBe('internal_error');
    expect(res.body).not.toContain('secret');
  });

  it('never sends a response that breaks its own schema', async () => {
    const res = await app.inject({
      method: 'GET',
      url: '/v1/test/bad-response',
      headers: { authorization: `Bearer ${await signToken()}` },
    });
    expect(res.statusCode).toBe(500);
    expect(apiErrorSchema.parse(res.json()).error.code).toBe('internal_error');
  });
});

describe('route rules', () => {
  it('refuses to start with a route that has no response schema', async () => {
    const strict = await buildTestApp(ctx);
    expect(() => strict.get('/v1/test/unchecked', () => ({}))).toThrow(/no response schema/);
    await strict.close();
  });
});

describe('rate limiting', () => {
  it('answers 429 rate_limited once a client goes over the limit', async () => {
    const limited = await buildTestApp(ctx, { RATE_LIMIT_PER_MINUTE: 3 });
    await limited.ready();
    const statuses: number[] = [];
    let last;
    for (let i = 0; i < 4; i++) {
      last = await limited.inject({ method: 'GET', url: '/v1/me' });
      statuses.push(last.statusCode);
    }
    expect(statuses).toEqual([401, 401, 401, 429]);
    expect(apiErrorSchema.parse(last?.json()).error.code).toBe('rate_limited');
    await limited.close();
  });
});
