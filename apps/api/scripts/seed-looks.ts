// Loads outfit photos + looks.json into the database as published looks. From the repo root:
//   pnpm seed:looks ./my-photos --init   writes looks.json (one look per photo) for you to fill in
//   pnpm seed:looks ./my-photos          loads them (safe to run again; needs DATABASE_URL and R2_* in .env)
import { resolve } from 'node:path';
import { createDb } from '@outfitly/db';
import { loadConfig, r2Config } from '../src/config.ts';
import { R2Storage } from '../src/storage.ts';
import { SEED_FILE, SeedFileError, seedLooks, writeSeedTemplate } from './seed/looks.ts';

const args = process.argv.slice(2);
const folderArg = args.find((a) => !a.startsWith('--'));
if (!folderArg) {
  console.error('Usage: pnpm seed:looks ./photo-folder [--init]');
  process.exit(1);
}
const folder = resolve(process.env['INIT_CWD'] ?? process.cwd(), folderArg);

try {
  if (args.includes('--init')) {
    const count = await writeSeedTemplate(folder);
    console.log(`Wrote ${SEED_FILE} with ${String(count)} looks (one per photo).`);
    console.log('Fill in caption, tags and author, then run again without --init.');
    process.exit(0);
  }

  const config = loadConfig();
  if (config.NODE_ENV === 'production') {
    console.error('Refusing to seed with NODE_ENV=production.');
    process.exit(1);
  }
  const db = createDb(config.DATABASE_URL, { caCert: config.DATABASE_CA_CERT });
  const started = performance.now();
  try {
    const result = await seedLooks({
      db,
      storage: new R2Storage(r2Config(config)),
      folder,
      log: (line) => {
        console.log(line);
      },
    });
    const seconds = ((performance.now() - started) / 1000).toFixed(1);
    console.log(
      `Done in ${seconds} s: ${String(result.looksCreated)} looks created, ` +
        `${String(result.looksUpdated)} updated; ${String(result.photosProcessed)} photos processed, ` +
        `${String(result.photosSkipped)} already there.`,
    );
    if (result.failures.length > 0) {
      console.error(`${String(result.failures.length)} photos failed (their looks were skipped):`);
      for (const f of result.failures) console.error(`  ${f.photo}: ${f.reason}`);
      process.exitCode = 1;
    }
  } finally {
    await db.$client.end();
  }
} catch (error) {
  if (!(error instanceof SeedFileError)) throw error;
  console.error(error.message);
  process.exit(1);
}
