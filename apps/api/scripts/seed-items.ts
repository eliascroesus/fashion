// Adds the seed looks' shop links (the "links" lists in looks.json) as look items and runs the
// link check on each (Step 3.5). From the repo root:
//   pnpm seed:items ~/Downloads/outfitly-seed
// Reads each link from the shop (like pasting it in the app), copies and fingerprints the product
// photo, reads the look's photos with Gemini if that hasn't happened yet, and checks the items.
// Safe to run again: links already on a look keep their check; links taken out of the file come
// off the look. Needs DATABASE_URL, R2_* and (to check anything) EMBEDDER_* and GEMINI_API_KEY.
import { resolve } from 'node:path';
import { createDb } from '@outfitly/db';
import { photoAiClients } from '../src/ai/clients.ts';
import { loadConfig, r2Config } from '../src/config.ts';
import { R2Storage } from '../src/storage.ts';
import { seedLookItems } from './seed/items.ts';
import { SeedFileError } from './seed/looks.ts';

const folderArg = process.argv.slice(2).find((a) => !a.startsWith('--'));
if (!folderArg) {
  console.error('Usage: pnpm seed:items ./photo-folder');
  process.exit(1);
}
const folder = resolve(process.env['INIT_CWD'] ?? process.cwd(), folderArg);

const config = loadConfig();
if (config.NODE_ENV === 'production') {
  console.error('Refusing to seed with NODE_ENV=production.');
  process.exit(1);
}
const ai = photoAiClients(config);
if (!ai.embedder) console.warn('No EMBEDDER_URL / EMBEDDER_SECRET: nothing can be compared.');
if (!ai.gemini) console.warn('No GEMINI_API_KEY: photos aren’t read and in-between items wait.');
const db = createDb(config.DATABASE_URL, { caCert: config.DATABASE_CA_CERT });
try {
  const result = await seedLookItems({
    db,
    storage: new R2Storage(r2Config(config)),
    folder,
    ...ai,
    log: (line) => {
      console.log(line);
    },
  });
  console.table(
    result.rows.map((r) => ({
      look: r.look,
      product: r.product?.slice(0, 40) ?? '',
      outcome: r.outcome,
      reason: r.reason ?? '',
      score: r.similarity === null ? '' : r.similarity.toFixed(3),
      link: r.link.length > 60 ? `${r.link.slice(0, 57)}…` : r.link,
    })),
  );
  const count = (outcome: string) => result.rows.filter((r) => r.outcome === outcome).length;
  const total = result.rows.length;
  const verified = count('verified');
  console.log(
    `${String(total)} links: ${String(verified)} verified` +
      (total > 0 ? ` (${((verified / total) * 100).toFixed(0)}%)` : '') +
      `, ${String(count('rejected'))} rejected, ${String(count('review'))} for review, ` +
      `${String(count('waiting'))} waiting, ${String(count('problem'))} with a problem; ` +
      `${String(result.removed)} removed. AI cost this run: $${(result.costMicros / 1e6).toFixed(4)}.`,
  );
  if (result.capReached) {
    console.error('The daily AI spend cap was reached: run again tomorrow for the rest.');
    process.exitCode = 1;
  }
} catch (error) {
  if (!(error instanceof SeedFileError)) throw error;
  console.error(error.message);
  process.exitCode = 1;
} finally {
  await db.$client.end();
}
