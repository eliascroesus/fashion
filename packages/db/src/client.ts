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
  /** Told when an idle connection drops (default: printed). The pool replaces it. */
  onConnectionError?: (error: Error) => void;
}

/**
 * Database client for the API and scripts. Use Supabase's direct or session
 * connection (port 5432), never the transaction pooler: pg-boss needs sessions.
 * Close with `db.$client.end()`.
 */
export function createDb(connectionString: string, options: DbOptions = {}) {
  const ssl = options.caCert ? { ca: options.caCert } : undefined;
  const db = drizzle({ connection: { connectionString, ssl, max: options.max ?? 5 }, schema });
  // A connection the network or Supabase drops errors on the pool while it sits idle, or on the
  // connection itself while a query holds it. pg throws a broken connection away (an idle one at
  // once, a held one when it's given back, and its query fails as usual); without listeners Node
  // would end the whole process.
  db.$client.on(
    'error',
    options.onConnectionError ??
      ((error) => {
        console.error(`Database connection dropped while idle: ${error.message}`);
      }),
  );
  db.$client.on('connect', (client) => {
    // Only keeps the process alive: the failing query reports it (an idle one is told above).
    client.on('error', () => undefined);
  });
  return db;
}

export type Db = ReturnType<typeof createDb>;
