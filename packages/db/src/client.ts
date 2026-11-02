import { drizzle } from 'drizzle-orm/node-postgres';
import * as schema from './schema/index.ts';

/**
 * Database client for the API and scripts. Use Supabase's direct or session
 * connection (port 5432), never the transaction pooler: pg-boss needs sessions.
 * Close with `db.$client.end()`.
 */
export function createDb(connectionString: string) {
  return drizzle({ connection: { connectionString }, schema });
}

export type Db = ReturnType<typeof createDb>;
