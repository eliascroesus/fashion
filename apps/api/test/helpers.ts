import { randomUUID } from 'node:crypto';
import { createDb, type Db } from '@outfitly/db';
import { createMigratedTestDatabase, type TestDatabase } from '@outfitly/db/testing';
import type { FastifyInstance } from 'fastify';
import { createLocalJWKSet, exportJWK, generateKeyPair, SignJWT } from 'jose';
import { buildApp } from '../src/app.ts';
import { type Config, loadConfig } from '../src/config.ts';
import type { JobQueue } from '../src/jobs.ts';
import { MemoryStorage } from './memory-storage.ts';

export const SUPABASE_URL = 'https://test-project.supabase.co';

/** A stand-in for Supabase's signing key, so tests can mint real login tokens. */
const keys = await generateKeyPair('ES256');
const publicJwk = { ...(await exportJWK(keys.publicKey)), kid: 'test-key', alg: 'ES256' };
export const testJwks = createLocalJWKSet({ keys: [publicJwk] });

export interface TokenOptions {
  sub?: string;
  isAnonymous?: boolean;
  email?: string;
  expiresIn?: string;
  issuer?: string;
  audience?: string;
  role?: string;
}

/** A Supabase-style access token signed with the test key. */
export async function signToken(options: TokenOptions = {}): Promise<string> {
  return new SignJWT({
    role: options.role ?? 'authenticated',
    is_anonymous: options.isAnonymous ?? false,
    ...(options.email ? { email: options.email } : {}),
  })
    .setProtectedHeader({ alg: 'ES256', kid: 'test-key' })
    .setSubject(options.sub ?? randomUUID())
    .setIssuer(options.issuer ?? `${SUPABASE_URL}/auth/v1`)
    .setAudience(options.audience ?? 'authenticated')
    .setIssuedAt()
    .setExpirationTime(options.expiresIn ?? '1h')
    .sign(keys.privateKey);
}

export function testConfig(databaseUrl: string, overrides: Partial<Config> = {}): Config {
  return {
    ...loadConfig({
      NODE_ENV: 'test',
      DATABASE_URL: databaseUrl,
      SUPABASE_URL,
      R2_ACCOUNT_ID: 'test',
      R2_ACCESS_KEY_ID: 'test',
      R2_SECRET_ACCESS_KEY: 'test',
      R2_ORIGINALS_BUCKET: 'originals',
      R2_PUBLIC_BUCKET: 'public',
      MEDIA_PUBLIC_BASE_URL: 'https://img.test',
    }),
    ...overrides,
  };
}

export interface TestContext {
  testDb: TestDatabase;
  db: Db;
  storage: MemoryStorage;
  /** Jobs the API asked for (tests that need real workers start pg-boss themselves). */
  queued: { name: string; data: object | null | undefined }[];
  queue: JobQueue;
  close: () => Promise<void>;
}

/** A migrated database plus a Drizzle client, for one test file. */
export async function createTestContext(): Promise<TestContext> {
  const testDb = await createMigratedTestDatabase();
  const db = createDb(testDb.url);
  const queued: TestContext['queued'] = [];
  const queue: JobQueue = {
    send: ((name: string, data?: object | null) => {
      queued.push({ name, data });
      return Promise.resolve(randomUUID());
    }) as JobQueue['send'],
  };
  return {
    testDb,
    db,
    storage: new MemoryStorage(),
    queued,
    queue,
    close: async () => {
      await db.$client.end();
      await testDb.drop();
    },
  };
}

/** The API wired to the test database and test signing key; not yet `ready()`. */
export async function buildTestApp(
  ctx: TestContext,
  overrides: Partial<Config> = {},
): Promise<FastifyInstance> {
  return buildApp({
    config: testConfig(ctx.testDb.url, overrides),
    db: ctx.db,
    jwks: testJwks,
    storage: ctx.storage,
    queue: ctx.queue,
    logger: false,
  });
}
