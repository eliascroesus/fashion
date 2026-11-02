import pg from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { runMigrations } from '../src/migrate.ts';
import { seed } from '../src/seed.ts';
import { createTestDatabase, type TestDatabase, withDb } from './test-database.ts';

const EXPECTED_TABLES = ['feature_flags', 'media', 'profile_members', 'profiles'];
const CLIENT_ROLES = ['anon', 'authenticated'];

let testDb: TestDatabase;
let client: pg.Client;

async function publicTables(): Promise<string[]> {
  const { rows } = await client.query<{ tablename: string }>(
    `SELECT tablename FROM pg_tables WHERE schemaname = 'public' ORDER BY tablename`,
  );
  return rows.map((r) => r.tablename);
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
    expect(await publicTables()).toEqual(EXPECTED_TABLES);
  });

  it('are safe to run again', async () => {
    await expect(runMigrations(testDb.url)).resolves.toBeUndefined();
    expect(await publicTables()).toEqual(EXPECTED_TABLES);
  });

  it('turn on pgvector and pg_trgm', async () => {
    const { rows } = await client.query<{ extname: string }>(
      `SELECT extname FROM pg_extension WHERE extname IN ('vector', 'pg_trgm') ORDER BY extname`,
    );
    expect(rows.map((r) => r.extname)).toEqual(['pg_trgm', 'vector']);
  });
});

describe('client access is closed', () => {
  it('has Row Level Security on every table, with no policies', async () => {
    const { rows } = await client.query<{ relname: string; relrowsecurity: boolean }>(
      `SELECT c.relname, c.relrowsecurity
         FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace
        WHERE n.nspname = 'public' AND c.relkind = 'r'`,
    );
    expect(rows.length).toBeGreaterThan(0);
    for (const row of rows) expect(row, row.relname).toMatchObject({ relrowsecurity: true });

    const policies = await client.query(`SELECT 1 FROM pg_policies WHERE schemaname = 'public'`);
    expect(policies.rowCount).toBe(0);
  });

  it('the public app key (anon) and logged-in users cannot read or write any table', async () => {
    await withDb(testDb.url, seed);
    for (const role of CLIENT_ROLES) {
      for (const table of await publicTables()) {
        await expect(
          asRole(role, `SELECT * FROM public.${table}`),
          `${role} ${table}`,
        ).rejects.toMatchObject({ code: '42501' });
        await expect(
          asRole(role, `DELETE FROM public.${table}`),
          `${role} delete ${table}`,
        ).rejects.toMatchObject({ code: '42501' });
      }
    }
  });

  it('RLS still hides every row if a grant ever slips through', async () => {
    await client.query('BEGIN');
    try {
      await client.query('GRANT SELECT ON public.profiles TO anon');
      await client.query('SET LOCAL ROLE anon');
      const { rowCount } = await client.query('SELECT * FROM public.profiles');
      expect(rowCount).toBe(0);
    } finally {
      await client.query('ROLLBACK');
    }
    const { rowCount } = await client.query('SELECT * FROM public.profiles');
    expect(rowCount).toBeGreaterThan(0);
  });

  it('tables added by later migrations start locked too', async () => {
    await client.query('BEGIN');
    try {
      await client.query('CREATE TABLE public.future_table (id int)');
      const { rows } = await client.query<{ role: string; allowed: boolean }>(
        `SELECT r AS role, has_table_privilege(r, 'public.future_table', 'SELECT') AS allowed
           FROM unnest($1::text[]) AS r`,
        [CLIENT_ROLES],
      );
      expect(rows).toEqual(CLIENT_ROLES.map((role) => ({ role, allowed: false })));
    } finally {
      await client.query('ROLLBACK');
    }
  });
});
