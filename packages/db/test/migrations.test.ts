import { readFileSync } from 'node:fs';
import pg from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { migrationsFolder, runMigrations } from '../src/migrate.ts';
import { seed } from '../src/seed.ts';
import { createTestDatabase, type TestDatabase, withDb } from './test-database.ts';

const EXPECTED_TABLES = [
  'ai_calls',
  'board_items',
  'boards',
  'clicks',
  'events',
  'events_default',
  'feature_flags',
  'feed_snapshots',
  'follows',
  'garments',
  'idempotency_keys',
  'link_checks',
  'look_items',
  'look_media',
  'looks',
  'media',
  'moderation_queue',
  'offers',
  'products',
  'profile_members',
  'profiles',
  'saves',
  'search_terms',
  'seen',
  'swipes',
  'taste_profiles',
];
/** Supabase's API roles: public app key, logged-in users, secret key. */
const API_ROLES = ['anon', 'authenticated', 'service_role'];

let testDb: TestDatabase;
let client: pg.Client;

/** Tables, partitioned tables, views and materialized views in public. */
async function publicRelations(): Promise<{ relname: string; relrowsecurity: boolean }[]> {
  const { rows } = await client.query<{ relname: string; relrowsecurity: boolean }>(
    `SELECT c.relname, c.relrowsecurity
       FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace
      WHERE n.nspname = 'public' AND c.relkind IN ('r', 'p', 'v', 'm')
      ORDER BY c.relname`,
  );
  return rows;
}

/** Runs `sql` as `role` inside a transaction that is always rolled back. */
async function asRole(role: string, sql: string): Promise<pg.QueryResult> {
  await client.query('BEGIN');
  try {
    await client.query(`SET LOCAL ROLE ${role}`);
    return await client.query(sql);
  } finally {
    await client.query('ROLLBACK');
  }
}

/** Runs `fn` inside a transaction that is always rolled back. */
async function rolledBack(fn: () => Promise<void>): Promise<void> {
  await client.query('BEGIN');
  try {
    await fn();
  } finally {
    await client.query('ROLLBACK');
  }
}

beforeAll(async () => {
  testDb = await createTestDatabase();
  await runMigrations(testDb.url);
  client = new pg.Client({ connectionString: testDb.url });
  await client.connect();
});

afterAll(async () => {
  await client.end();
  await testDb.drop();
});

describe('migrations', () => {
  it('apply to an empty database from scratch', async () => {
    expect((await publicRelations()).map((r) => r.relname)).toEqual(EXPECTED_TABLES);
  });

  it('are safe to run again', async () => {
    await expect(runMigrations(testDb.url)).resolves.toBeUndefined();
    expect((await publicRelations()).map((r) => r.relname)).toEqual(EXPECTED_TABLES);
  });

  it('turn on pgvector and pg_trgm in the extensions schema', async () => {
    const { rows } = await client.query<{ extname: string; schema: string }>(
      `SELECT e.extname, n.nspname AS schema
         FROM pg_extension e JOIN pg_namespace n ON n.oid = e.extnamespace
        WHERE e.extname IN ('vector', 'pg_trgm') ORDER BY e.extname`,
    );
    expect(rows).toEqual([
      { extname: 'pg_trgm', schema: 'extensions' },
      { extname: 'vector', schema: 'extensions' },
    ]);
  });

  it('are listed in strictly increasing time order (the migrator skips out-of-order ones)', () => {
    const journal = JSON.parse(readFileSync(`${migrationsFolder}/meta/_journal.json`, 'utf8')) as {
      entries: { when: number; tag: string }[];
    };
    const times = journal.entries.map((e) => e.when);
    expect(times).toEqual([...times].sort((a, b) => a - b));
    expect(new Set(times).size).toBe(times.length);
  });
});

describe('client access is closed', () => {
  it('has Row Level Security on every table, with no policies', async () => {
    const tables = (await publicRelations()).filter((r) => EXPECTED_TABLES.includes(r.relname));
    expect(tables).toHaveLength(EXPECTED_TABLES.length);
    for (const row of await publicRelations()) {
      expect(row, row.relname).toMatchObject({ relrowsecurity: true });
    }

    const policies = await client.query(`SELECT 1 FROM pg_policies WHERE schemaname = 'public'`);
    expect(policies.rowCount).toBe(0);
  });

  it('the public app key, logged-in users and the secret key cannot read or write any table', async () => {
    await withDb(testDb.url, seed);
    for (const role of API_ROLES) {
      for (const { relname } of await publicRelations()) {
        await expect(
          asRole(role, `SELECT * FROM public.${relname}`),
          `${role} select ${relname}`,
        ).rejects.toMatchObject({ code: '42501' });
        await expect(
          asRole(role, `DELETE FROM public.${relname}`),
          `${role} delete ${relname}`,
        ).rejects.toMatchObject({ code: '42501' });
      }
    }
  });

  it('RLS still hides every row if a grant ever slips through', async () => {
    await rolledBack(async () => {
      await client.query('GRANT SELECT ON public.profiles TO anon');
      await client.query('SET LOCAL ROLE anon');
      const { rowCount } = await client.query('SELECT * FROM public.profiles');
      expect(rowCount).toBe(0);
    });
    const { rowCount } = await client.query('SELECT * FROM public.profiles');
    expect(rowCount).toBeGreaterThan(0);
  });

  it('tables and functions added later start locked too', async () => {
    await rolledBack(async () => {
      await client.query('CREATE TABLE public.future_table (id int)');
      await client.query(
        'CREATE FUNCTION public.future_fn() RETURNS int LANGUAGE sql AS $$ SELECT 1 $$',
      );
      const { rows } = await client.query<{ role: string; can_select: boolean; can_run: boolean }>(
        `SELECT r AS role,
                has_table_privilege(r, 'public.future_table', 'SELECT') AS can_select,
                has_function_privilege(r, 'public.future_fn()', 'EXECUTE') AS can_run
           FROM unnest($1::text[]) AS r`,
        [API_ROLES],
      );
      expect(rows).toEqual(API_ROLES.map((role) => ({ role, can_select: false, can_run: false })));
    });
  });
});
