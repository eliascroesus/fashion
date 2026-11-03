// Fake looks for speed tests (placeholder pictures, posters @loadtest.01–20). From the repo root:
//   pnpm seed:fake-looks              adds fake looks until there are 10,000 (safe to run again)
//   pnpm seed:fake-looks --count 500  … until there are 500
//   pnpm seed:fake-looks --count 300 --pictures 300   300 looks, each with its own cover picture
//   pnpm seed:fake-looks --remove     deletes every fake look, picture and poster
import { createDb } from '@outfitly/db';
import { loadConfig, r2Config } from '../src/config.ts';
import { R2Storage } from '../src/storage.ts';
import { countFakeLooks, removeFakeLooks, seedFakeLooks } from './seed/fake-looks.ts';

const args = process.argv.slice(2);
const countArg = args[args.indexOf('--count') + 1];
const count = args.includes('--count') ? Number(countArg) : 10_000;
const picturesArg = args[args.indexOf('--pictures') + 1];
const pictures = args.includes('--pictures') ? Number(picturesArg) : 30;
if (!Number.isInteger(count) || count < 1 || !Number.isInteger(pictures) || pictures < 1) {
  console.error('Usage: pnpm seed:fake-looks [--count N] [--pictures N] [--remove]');
  process.exit(1);
}

const config = loadConfig();
if (config.NODE_ENV === 'production') {
  console.error('Refusing to add fake looks with NODE_ENV=production.');
  process.exit(1);
}
const db = createDb(config.DATABASE_URL, { caCert: config.DATABASE_CA_CERT });
try {
  const started = performance.now();
  if (args.includes('--remove')) {
    const { looks } = await removeFakeLooks(db);
    console.log(`Removed ${String(looks)} fake looks and their posters.`);
  } else {
    const { inserted } = await seedFakeLooks({
      db,
      storage: new R2Storage(r2Config(config)),
      count,
      poolSize: pictures,
      log: (line) => {
        console.log(line);
      },
    });
    const seconds = ((performance.now() - started) / 1000).toFixed(1);
    console.log(
      `Added ${String(inserted)} fake looks in ${seconds} s; ${String(await countFakeLooks(db))} in total.`,
    );
  }
} finally {
  await db.$client.end();
}
