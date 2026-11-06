// Test pieces on one look, to try "shop the look" (Step 3.6) and its Maestro flow before real
// links are verified. From the repo root (uses the database in .env):
//   pnpm shop:test-look                 5 test pieces on the newest @outfitly.picks look
//   pnpm shop:test-look --look <id>     … on that look
//   pnpm shop:test-look --remove        deletes every test piece, link and product again
// With fingerprinted covers (pnpm ai:fingerprint) it also puts look-alike test coats on the looks
// most like it, so the test coat's "Similar pieces" (Step 3.8) has something to show.
import { createDb } from '@outfitly/db';
import { loadConfig } from '../src/config.ts';
import {
  addLookalikeCoats,
  addShopTestLook,
  pickTestLook,
  removeShopTestPieces,
} from './seed/shop-test-look.ts';

const args = process.argv.slice(2);
const lookArg = args.includes('--look') ? args[args.indexOf('--look') + 1] : undefined;
if (args.includes('--look') && !lookArg) {
  console.error('Usage: pnpm shop:test-look [--look <id>] [--remove]');
  process.exit(1);
}

const config = loadConfig();
if (config.NODE_ENV === 'production') {
  console.error('Refusing to add test pieces with NODE_ENV=production.');
  process.exit(1);
}
const db = createDb(config.DATABASE_URL, { caCert: config.DATABASE_CA_CERT });
try {
  if (args.includes('--remove')) {
    console.log(`Removed ${String(await removeShopTestPieces(db))} test pieces.`);
  } else {
    const lookId = await pickTestLook(db, lookArg);
    if (!lookId) throw new Error('No published look found.');
    const count = await addShopTestLook(db, lookId);
    const lookalikes = await addLookalikeCoats(db, lookId);
    console.log(
      `Added ${String(count)} test pieces to look ${lookId}, and ${String(lookalikes)} look-alike test coats to other looks. Try it with:`,
    );
    console.log(
      `  maestro test -e APP_ID=com.outfitly.app.dev -e SCHEME=outfitly-dev -e LOOK_ID=${lookId} apps/mobile/.maestro/shop-the-look.yaml`,
    );
    console.log('Remove them again with: pnpm shop:test-look --remove');
  }
} finally {
  await db.$client.end();
}
