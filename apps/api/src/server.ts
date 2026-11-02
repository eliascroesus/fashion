import { createDb } from '@outfitly/db';
import { buildApp } from './app.ts';
import { supabaseJwks } from './auth.ts';
import { loadConfig } from './config.ts';
import { QUEUES, startJobs } from './jobs.ts';

const config = loadConfig();
const db = createDb(config.DATABASE_URL, { caCert: config.DATABASE_CA_CERT });
const app = await buildApp({ config, db, jwks: supabaseJwks(config.SUPABASE_URL) });
const boss = await startJobs({
  databaseUrl: config.DATABASE_URL,
  caCert: config.DATABASE_CA_CERT,
  db,
  log: app.log,
});
await boss.send(QUEUES.ping, { reason: 'startup' });
await app.listen({ host: config.HOST, port: config.PORT });

let shuttingDown = false;
async function shutdown(signal: string): Promise<void> {
  if (shuttingDown) return;
  shuttingDown = true;
  app.log.info({ signal }, 'shutting down');
  await app.close();
  await boss.stop({ graceful: true, timeout: 20_000 });
  await db.$client.end();
  process.exit(0);
}
for (const signal of ['SIGINT', 'SIGTERM'] as const) {
  process.once(signal, () => void shutdown(signal));
}
