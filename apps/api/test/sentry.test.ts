import type { ErrorEvent } from '@sentry/node';
import * as Sentry from '@sentry/node';
import type { FastifyInstance } from 'fastify';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { z } from 'zod';
import { initSentry } from '../src/sentry.ts';
import { buildTestApp, createTestContext, signToken, type TestContext } from './helpers.ts';

const sent: ErrorEvent[] = [];
let ctx: TestContext;
let app: FastifyInstance;

beforeAll(async () => {
  // Capture events in memory instead of sending them anywhere.
  initSentry({
    dsn: 'https://public@o0.ingest.sentry.io/0',
    environment: 'test',
    beforeSend: (event) => {
      sent.push(event);
      return null;
    },
  });
  ctx = await createTestContext();
  app = await buildTestApp(ctx);
  app.get('/v1/test/crash', { schema: { response: { 200: z.object({}) } } }, () => {
    throw new Error('boom for sentry');
  });
  await app.ready();
});

afterAll(async () => {
  await app.close();
  await ctx.close();
  await Sentry.close();
});

describe('Sentry', () => {
  it('reports server errors without login details', async () => {
    const res = await app.inject({
      method: 'GET',
      url: '/v1/test/crash',
      headers: { authorization: `Bearer ${await signToken()}` },
    });
    expect(res.statusCode).toBe(500);
    await Sentry.flush(2000);
    const event = sent.find((e) => e.exception?.values?.[0]?.value === 'boom for sentry');
    expect(event).toBeDefined();
    expect(JSON.stringify(event)).not.toMatch(/Bearer|authorization/i);
  });

  it('does not report client mistakes (4xx)', async () => {
    const before = sent.length;
    await app.inject({ method: 'GET', url: '/v1/me' });
    await app.inject({ method: 'GET', url: '/v1/nope' });
    await Sentry.flush(2000);
    expect(sent.length).toBe(before);
  });
});
