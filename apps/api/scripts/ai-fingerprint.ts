// Fingerprints looks' photos that have none yet (the whole photo and any garments), so "More like
// this" and search by words can use them. No Gemini needed. From the repo root:
//   pnpm ai:fingerprint                      every look photo without a fingerprint
//   pnpm ai:fingerprint --author outfitly.picks
// Safe to run again: photos already fingerprinted are skipped. Needs EMBEDDER_URL + EMBEDDER_SECRET
// in .env (the fingerprint service fetches the photos from our public R2 copy).
import { createDb, sql } from '@outfitly/db';
import { photoAiClients } from '../src/ai/clients.ts';
import { EmbedderError } from '../src/ai/embedder.ts';
import { fingerprintPhoto, type PhotoAiDeps } from '../src/ai/photos.ts';
import { loadConfig, r2Config } from '../src/config.ts';
import { R2Storage } from '../src/storage.ts';

const args = process.argv.slice(2);
const authorIndex = args.indexOf('--author');
const handle = authorIndex === -1 ? null : (args[authorIndex + 1] ?? '').replace(/^@/, '');

const config = loadConfig();
const ai = photoAiClients(config);
if (!ai.embedder) {
  console.error('No EMBEDDER_URL / EMBEDDER_SECRET in .env: nothing can be fingerprinted.');
  process.exit(1);
}
const db = createDb(config.DATABASE_URL, { caCert: config.DATABASE_CA_CERT });
const deps: PhotoAiDeps = { db, storage: new R2Storage(r2Config(config)), ...ai };

/** Tries again (after 5 s, then 10 s) when the fingerprint service says it's worth it. */
async function withRetries<T>(work: () => Promise<T>): Promise<T> {
  for (let attempt = 1; ; attempt += 1) {
    try {
      return await work();
    } catch (error) {
      if (!(error instanceof EmbedderError) || !error.retryable || attempt === 3) throw error;
      await new Promise((resolve) => setTimeout(resolve, attempt * 5000));
    }
  }
}

try {
  // Look photos (any position) still missing a whole-photo or garment fingerprint, oldest first.
  const { rows } = await db.execute<{ id: string }>(sql`
    SELECT m.id FROM media m
     WHERE m.status = 'ready' AND m.deleted_at IS NULL
       AND EXISTS (SELECT 1 FROM look_media lm JOIN looks l ON l.id = lm.look_id
                    JOIN profiles p ON p.id = l.author_profile_id
                   WHERE lm.media_id = m.id AND l.deleted_at IS NULL
                     AND (${handle}::text IS NULL OR p.handle = ${handle}))
       AND (m.embedding IS NULL
            OR EXISTS (SELECT 1 FROM garments g WHERE g.media_id = m.id AND g.deleted_at IS NULL
                          AND g.embedding IS NULL))
     ORDER BY m.created_at, m.id`);
  console.log(`${String(rows.length)} photos to fingerprint.`);
  let done = 0;
  let fingerprints = 0;
  let failed = 0;
  const started = performance.now();
  for (const { id } of rows) {
    try {
      const result = await withRetries(() => fingerprintPhoto(deps, id));
      if (result.outcome === 'done') fingerprints += result.fingerprints;
    } catch (error) {
      failed += 1;
      console.error(`  ${id}: ${error instanceof Error ? error.message : String(error)}`);
    }
    done += 1;
    if (done % 10 === 0 || done === rows.length) {
      console.log(`  ${String(done)}/${String(rows.length)}`);
    }
  }
  const seconds = ((performance.now() - started) / 1000).toFixed(1);
  console.log(
    `Saved ${String(fingerprints)} fingerprints in ${seconds} s; ${String(failed)} photos failed.`,
  );
  if (failed > 0) process.exitCode = 1;
} finally {
  await db.$client.end();
}
