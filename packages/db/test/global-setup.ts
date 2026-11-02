import pg from 'pg';
import { SUPABASE_ROLES_SQL } from './supabase-shim.ts';
import { adminUrl } from './test-database.ts';

export default async function setup(): Promise<void> {
  const client = new pg.Client({ connectionString: adminUrl() });
  await client.connect();
  try {
    await client.query(SUPABASE_ROLES_SQL);
  } finally {
    await client.end();
  }
}
