import { drizzle } from 'drizzle-orm/node-postgres';
import * as schema from './schema/index.ts';

export interface DbOptions {
  /**
   * Supabase's CA certificate (PEM). When set, the connection uses TLS and
   * verifies the server against it. Leave `sslmode` out of the URL: pg lets
   * URL parameters override this setting.
   */
  caCert?: string | undefined;
  /** Most connections this client opens (keep within the Supabase pooler's size). */
  max?: number;
}

/**
 * Database client for the API and scripts. Use Supabase's direct or session
 * connection (port 5432), never the transaction pooler: pg-boss needs sessions.
 * Close with `db.$client.end()`.
 */
export function createDb(connectionString: string, options: DbOptions = {}) {
  const ssl = options.caCert ? { ca: options.caCert } : undefined;
  return drizzle({ connection: { connectionString, ssl, max: options.max ?? 5 }, schema });
}

export type Db = ReturnType<typeof createDb>;
