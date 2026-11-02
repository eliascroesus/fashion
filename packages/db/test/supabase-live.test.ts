import { getTableName, is } from 'drizzle-orm';
import { PgTable } from 'drizzle-orm/pg-core';
import { describe, expect, it } from 'vitest';
import * as schema from '../src/schema/index.ts';

const supabaseUrl = process.env['SUPABASE_URL'];
const publishableKey = process.env['SUPABASE_PUBLISHABLE_KEY'];

const tables = Object.values(schema)
  .filter((value) => is(value, PgTable))
  .map((table) => getTableName(table));

// Runs only when a real Supabase project is configured in .env.
describe.skipIf(!supabaseUrl || !publishableKey)('live Supabase project', () => {
  it.each(tables)('the public app key cannot read %s', async (table) => {
    const res = await fetch(`${String(supabaseUrl)}/rest/v1/${table}?select=*&limit=1`, {
      headers: { apikey: String(publishableKey) },
      signal: AbortSignal.timeout(10_000),
    });
    expect(res.ok, `${table}: HTTP ${String(res.status)} ${await res.text()}`).toBe(false);
  });
});
