import { randomUUID } from 'node:crypto';
import { createDb, type Db } from '@outfitly/db';
import { createMigratedTestDatabase, type TestDatabase } from '@outfitly/db/testing';
import type { FastifyInstance } from 'fastify';
import { createLocalJWKSet, exportJWK, generateKeyPair, SignJWT } from 'jose';
import { buildApp } from '../src/app.ts';
import { type Config, loadConfig } from '../src/config.ts';

export const SUPABASE_URL = 'https://test-project.supabase.co';

/** A stand-in for Supabase's signing key, so tests can mint real login tokens. */
const keys = await generateKeyPair('ES256');
const publicJwk = { ...(await exportJWK(keys.publicKey)), kid: 'test-key', alg: 'ES256' };
export const testJwks = createLocalJWKSet({ keys: [publicJwk] });

export interface TokenOptions {
  sub?: string;
  isAnonymous?: boolean;
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
    ...loadConfig({ NODE_ENV: 'test', DATABASE_URL: databaseUrl, SUPABASE_URL }),
    ...overrides,
  };
}

export interface TestContext {
  testDb: TestDatabase;
  db: Db;
  close: () => Promise<void>;
}

/** A migrated database plus a Drizzle client, for one test file. */
export async function createTestContext(): Promise<TestContext> {
  const testDb = await createMigratedTestDatabase();
  const db = createDb(testDb.url);
  return {
    testDb,
    db,
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
    logger: false,
  });
}
