import { readFileSync } from 'node:fs';
import { eq, media, profileMembers, profiles, sql } from '@outfitly/db';
import { apiErrorSchema, mediaSchema, uploadTicketSchema } from '@outfitly/shared';
import type { FastifyInstance } from 'fastify';
import type { PgBoss } from 'pg-boss';
import sharp from 'sharp';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createJobQueue, QUEUES, startJobs } from '../src/jobs.ts';
import { buildTestApp, createTestContext, signToken, type TestContext } from './helpers.ts';

const IPHONE_HEIC = readFileSync(new URL('./fixtures/iphone-12mp-gps.heic', import.meta.url));

let ctx: TestContext;
let app: FastifyInstance;

/** A login with an active personal profile, like Step 1.6 will create. */
async function createMember(handle: string): Promise<{ token: string; profileId: string }> {
  const userId = crypto.randomUUID();
  await ctx.db.execute(sql`INSERT INTO auth.users (id) VALUES (${userId})`);
  const [profile] = await ctx.db.insert(profiles).values({ handle }).returning();
  if (!profile) throw new Error('no profile');
  await ctx.db.insert(profileMembers).values({ userId, profileId: profile.id, isActive: true });
  return { token: await signToken({ sub: userId }), profileId: profile.id };
}

async function call(token: string, method: 'GET' | 'POST', url: string, payload?: object) {
  return app.inject({
    method,
    url,
    headers: {
      authorization: `Bearer ${token}`,
      ...(method === 'POST' ? { 'idempotency-key': crypto.randomUUID() } : {}),
    },
    ...(payload ? { payload } : {}),
  });
}

async function requestUpload(token: string, byteSize = IPHONE_HEIC.length) {
  const res = await call(token, 'POST', '/v1/media/uploads', {
    contentType: 'image/heic',
    byteSize,
  });
  expect(res.statusCode).toBe(201);
  return uploadTicketSchema.parse(res.json());
}

let alice: { token: string; profileId: string };
let bob: { token: string; profileId: string };

beforeAll(async () => {
  ctx = await createTestContext();
  app = await buildTestApp(ctx);
  await app.ready();
  alice = await createMember('alice');
  bob = await createMember('bob');
});

afterAll(async () => {
  await app.close();
  await ctx.close();
});

describe('upload link', () => {
  it('is created for the active profile with a pending photo', async () => {
    const ticket = await requestUpload(alice.token);
    expect(ticket.uploadUrl).toContain(`originals/${ticket.mediaId}`);
    expect(ticket.uploadHeaders).toEqual({ 'content-type': 'image/heic' });
    const [row] = await ctx.db.select().from(media).where(eq(media.id, ticket.mediaId));
    expect(row).toMatchObject({ ownerProfileId: alice.profileId, status: 'pending' });
  });

  it('needs an active profile', async () => {
    const res = await call(await signToken(), 'POST', '/v1/media/uploads', {
      contentType: 'image/jpeg',
      byteSize: 100,
    });
    expect(res.statusCode).toBe(403);
    expect(apiErrorSchema.parse(res.json()).error.code).toBe('forbidden');
  });

  it.each([
    ['a file type that is not a photo', { contentType: 'application/pdf', byteSize: 100 }],
    ['a file over 25 MB', { contentType: 'image/jpeg', byteSize: 26 * 1024 * 1024 }],
  ])('refuses %s', async (_label, body) => {
    const res = await call(alice.token, 'POST', '/v1/media/uploads', body);
    expect(res.statusCode).toBe(400);
  });
});

describe('completing an upload', () => {
  it('refuses when nothing was uploaded yet', async () => {
    const ticket = await requestUpload(alice.token);
    const res = await call(alice.token, 'POST', `/v1/media/${ticket.mediaId}/complete`, {});
    expect(res.statusCode).toBe(409);
    expect(apiErrorSchema.parse(res.json()).error.code).toBe('conflict');
  });

  it('refuses a file that does not match the upload link', async () => {
    const ticket = await requestUpload(alice.token, 1000);
    ctx.storage.simulateUpload(`originals/${ticket.mediaId}`, Buffer.alloc(2000));
    const res = await call(alice.token, 'POST', `/v1/media/${ticket.mediaId}/complete`, {});
    expect(res.statusCode).toBe(409);
  });

  it('starts processing exactly once', async () => {
    const ticket = await requestUpload(alice.token);
    ctx.storage.simulateUpload(`originals/${ticket.mediaId}`, IPHONE_HEIC);
    const before = ctx.queued.length;
    const first = await call(alice.token, 'POST', `/v1/media/${ticket.mediaId}/complete`, {});
    const again = await call(alice.token, 'POST', `/v1/media/${ticket.mediaId}/complete`, {});
    expect(first.statusCode).toBe(202);
    expect(mediaSchema.parse(first.json())).toMatchObject({ status: 'processing', urls: null });
    expect(again.statusCode).toBe(202);
    expect(ctx.queued.slice(before)).toEqual([
      { name: QUEUES.mediaProcess, data: { mediaId: ticket.mediaId } },
    ]);
  });

  it("keeps other people's photos private", async () => {
    const ticket = await requestUpload(alice.token);
    const complete = await call(bob.token, 'POST', `/v1/media/${ticket.mediaId}/complete`, {});
    const read = await call(bob.token, 'GET', `/v1/media/${ticket.mediaId}`);
    expect([complete.statusCode, read.statusCode]).toEqual([404, 404]);
  });

  it('rejects ids that are not UUIDs', async () => {
    const res = await call(alice.token, 'GET', '/v1/media/not-a-uuid');
    expect(res.statusCode).toBe(400);
  });
});

describe('end to end with the background job', () => {
  let boss: PgBoss;

  beforeAll(async () => {
    boss = createJobQueue(ctx.testDb.url);
    await startJobs(boss, {
      db: ctx.db,
      storage: ctx.storage,
      log: app.log,
      pollingIntervalSeconds: 0.5,
    });
  });

  afterAll(async () => {
    await boss.stop({ graceful: false, close: true });
  });

  async function completeWith(body: Buffer) {
    const ticket = await requestUpload(alice.token, body.length);
    ctx.storage.simulateUpload(`originals/${ticket.mediaId}`, body);
    const res = await call(alice.token, 'POST', `/v1/media/${ticket.mediaId}/complete`, {});
    expect(res.statusCode).toBe(202);
    // The fake queue only records; hand the job to the real worker.
    await boss.send(QUEUES.mediaProcess, { mediaId: ticket.mediaId });
    return ticket.mediaId;
  }

  async function waitFor(mediaId: string, status: string) {
    await expect
      .poll(
        async () =>
          mediaSchema.parse((await call(alice.token, 'GET', `/v1/media/${mediaId}`)).json()).status,
        { timeout: 20_000, interval: 250 },
      )
      .toBe(status);
    return mediaSchema.parse((await call(alice.token, 'GET', `/v1/media/${mediaId}`)).json());
  }

  it('turns an iPhone photo into 3 public sizes with size, thumbhash and colour', async () => {
    const started = performance.now();
    const mediaId = await completeWith(IPHONE_HEIC);
    const ready = await waitFor(mediaId, 'ready');
    console.log(`upload → ready in ${((performance.now() - started) / 1000).toFixed(2)} s`);

    expect(ready).toMatchObject({ width: 1080, height: 810 });
    expect(ready.thumbhash).toBeTruthy();
    expect(ready.dominantColor).toMatch(/^#[0-9a-f]{6}$/);
    expect(ready.urls).toEqual({
      1080: `https://img.test/m/${mediaId}/1080.webp`,
      600: `https://img.test/m/${mediaId}/600.webp`,
      300: `https://img.test/m/${mediaId}/300.webp`,
    });
    for (const size of [1080, 600, 300]) {
      const stored = ctx.storage.publicObjects.get(`m/${mediaId}/${String(size)}.webp`);
      expect(stored?.contentType).toBe('image/webp');
      expect((await sharp(stored?.body).metadata()).exif).toBeUndefined();
    }
  });

  it('marks a file it cannot read as failed, without retrying', async () => {
    const mediaId = await completeWith(Buffer.from('this is not a photo at all'));
    const failed = await waitFor(mediaId, 'failed');
    expect(failed.urls).toBeNull();
  });
});
