import { createDb } from '@outfitly/db';
import { photoAiClients } from './ai/clients.ts';
import { buildApp } from './app.ts';
import { supabaseJwks } from './auth.ts';
import { loadConfig, r2Config } from './config.ts';
import { createJobQueue, QUEUES, startJobs } from './jobs.ts';
import { R2Storage } from './storage.ts';

const config = loadConfig();
// The app's logger exists only once the app is built; a drop before that is printed.
let logDroppedConnection = (error: Error): void => {
  console.error(`Database connection dropped while idle: ${error.message}`);
};
const db = createDb(config.DATABASE_URL, {
  caCert: config.DATABASE_CA_CERT,
  onConnectionError: (error) => {
    logDroppedConnection(error);
  },
});
const storage = new R2Storage(r2Config(config));
const boss = createJobQueue(config.DATABASE_URL, config.DATABASE_CA_CERT);
const app = await buildApp({
  config,
  db,
  jwks: supabaseJwks(config.SUPABASE_URL),
  storage,
  queue: boss,
});
logDroppedConnection = (err) => {
  app.log.warn({ err }, 'database connection dropped while idle');
};
const ai = photoAiClients(config);
app.log.info(
  { spotting: ai.gemini?.model ?? 'off', fingerprints: ai.embedder ? 'on' : 'off' },
  'photo AI',
);
await startJobs(boss, { db, storage, log: app.log, ai });
await boss.send(QUEUES.ping, { reason: 'startup' });
await boss.send(QUEUES.eventPartitions, {});
await boss.send(QUEUES.searchTerms, {});
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
