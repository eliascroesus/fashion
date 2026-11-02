import { fileURLToPath } from 'node:url';
import { migrate } from 'drizzle-orm/node-postgres/migrator';
import { createDb, type DbOptions } from './client.ts';

export const migrationsFolder = fileURLToPath(new URL('../migrations', import.meta.url));

/** Applies every pending migration. Safe to run repeatedly. */
export async function runMigrations(
  connectionString: string,
  options: DbOptions = {},
): Promise<void> {
  const db = createDb(connectionString, options);
  try {
    await migrate(db, { migrationsFolder });
  } finally {
    await db.$client.end();
  }
}
