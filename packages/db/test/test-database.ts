import { randomBytes } from 'node:crypto';
import pg from 'pg';
import { createDb, type Db } from '../src/client.ts';
import { runMigrations } from '../src/migrate.ts';
import { SUPABASE_ROLES_SQL, supabaseDatabaseSql } from './supabase-shim.ts';

export function adminUrl(): string {
  const url = process.env['TEST_DATABASE_URL'];
  if (!url) {
    throw new Error(
      'TEST_DATABASE_URL is not set. Point it at a Postgres 17 server with pgvector ' +
        '(see README "How to run"); tests create and drop their own databases there.',
    );
  }
  // Tests create roles and drop databases: never point them at a shared server.
  const host = new URL(url).hostname;
  if (!process.env['CI'] && !['localhost', '127.0.0.1', '::1', '[::1]'].includes(host)) {
    throw new Error(`TEST_DATABASE_URL must point at localhost, not ${host}.`);
  }
  return url;
}

/** Creates Supabase's API roles on the test server. Run once, from Vitest global setup. */
export async function ensureSupabaseRoles(): Promise<void> {
  const client = new pg.Client({ connectionString: adminUrl() });
  await client.connect();
  try {
    await client.query(SUPABASE_ROLES_SQL);
  } finally {
    await client.end();
  }
}

export interface TestDatabase {
  url: string;
  drop: () => Promise<void>;
}

/** Creates an empty, Supabase-shaped database that only this test file uses. */
export async function createTestDatabase(): Promise<TestDatabase> {
  const name = `outfitly_test_${randomBytes(6).toString('hex')}`;
  const admin = new pg.Client({ connectionString: adminUrl() });
  await admin.connect();
  try {
    await admin.query(`CREATE DATABASE ${name}`);
  } finally {
    await admin.end();
  }

  const url = new URL(adminUrl());
  url.pathname = `/${name}`;

  const client = new pg.Client({ connectionString: url.toString() });
  await client.connect();
  try {
    await client.query(supabaseDatabaseSql(name));
  } finally {
    await client.end();
  }

  return {
    url: url.toString(),
    drop: async () => {
      const dropper = new pg.Client({ connectionString: adminUrl() });
      await dropper.connect();
      try {
        await dropper.query(`DROP DATABASE IF EXISTS ${name} WITH (FORCE)`);
      } finally {
        await dropper.end();
      }
    },
  };
}

/** A fresh Supabase-shaped database with every migration applied. */
export async function createMigratedTestDatabase(): Promise<TestDatabase> {
  const testDb = await createTestDatabase();
  await runMigrations(testDb.url);
  return testDb;
}

/** Opens a Drizzle client for the duration of `fn`. */
export async function withDb<T>(url: string, fn: (db: Db) => Promise<T>): Promise<T> {
  const db = createDb(url);
  try {
    return await fn(db);
  } finally {
    await db.$client.end();
  }
}
