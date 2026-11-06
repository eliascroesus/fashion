// A test piece whose shop page is our own (a tiny product page in our public R2 bucket), to show the
// price and stock check (Step 3.9) end to end without asking a real shop. From the repo root (uses
// the database and R2 bucket in .env):
//   pnpm refresh:demo add [--look <id>]   the page (in stock, 1 499 kr) and a verified piece on the look
//   pnpm refresh:demo sold-out            the page now says sold out
//   pnpm refresh:demo in-stock            … in stock again
//   pnpm refresh:demo remove              deletes the page, the piece, its link and product
// Then `pnpm prices:refresh --page <the page's address>` checks it now (the look page greys it).
import { DeleteObjectCommand, PutObjectCommand, S3Client } from '@aws-sdk/client-s3';
import { createDb, eq, offers, sql } from '@outfitly/db';
import { loadConfig, r2Config } from '../src/config.ts';
import { r2Endpoint } from '../src/storage.ts';
import {
  attachDemoPiece,
  DEMO_PREFIX,
  demoPageHtml,
  removeDemoPieces,
} from './seed/refresh-demo.ts';
import { pickTestLook } from './seed/shop-test-look.ts';

const [command, ...rest] = process.argv.slice(2);
const lookArg = rest.includes('--look') ? rest[rest.indexOf('--look') + 1] : undefined;
const usage = 'Usage: pnpm refresh:demo add [--look <id>] | sold-out | in-stock | remove';
if (!command || !['add', 'sold-out', 'in-stock', 'remove'].includes(command)) {
  console.error(usage);
  process.exit(1);
}

const config = loadConfig();
if (config.NODE_ENV === 'production') {
  console.error('Refusing to add test pieces with NODE_ENV=production.');
  process.exit(1);
}
const r2 = r2Config(config);
const s3 = new S3Client({
  region: 'auto',
  endpoint: r2Endpoint(r2.accountId, r2.jurisdiction),
  forcePathStyle: true,
  credentials: { accessKeyId: r2.accessKeyId, secretAccessKey: r2.secretAccessKey },
  requestChecksumCalculation: 'WHEN_REQUIRED',
  responseChecksumValidation: 'WHEN_REQUIRED',
});
const key = `${DEMO_PREFIX}coat.html`;
const pageUrl = new URL(key, `${config.MEDIA_PUBLIC_BASE_URL.replace(/\/$/, '')}/`).href;

/** Writes the page; never cached, so a flip shows on the next read. */
async function putPage(stock: 'InStock' | 'OutOfStock'): Promise<void> {
  await s3.send(
    new PutObjectCommand({
      Bucket: r2.publicBucket,
      Key: key,
      Body: demoPageHtml(pageUrl, stock),
      ContentType: 'text/html; charset=utf-8',
      CacheControl: 'no-store',
    }),
  );
}

const db = createDb(config.DATABASE_URL, { caCert: config.DATABASE_CA_CERT });
try {
  if (command === 'remove') {
    const removed = await removeDemoPieces(db, config.MEDIA_PUBLIC_BASE_URL);
    await s3.send(new DeleteObjectCommand({ Bucket: r2.publicBucket, Key: key }));
    console.log(`Removed the demo page and ${String(removed)} demo piece(s).`);
  } else if (command === 'add') {
    const lookId = await pickTestLook(db, lookArg);
    if (!lookId) throw new Error('No published look found.');
    await putPage('InStock');
    const { offerId } = await attachDemoPiece(db, lookId, pageUrl);
    const [offer] = await db.select().from(offers).where(eq(offers.id, offerId));
    console.log(`Demo page: ${pageUrl}`);
    console.log(
      `Piece on look ${lookId}: ${offer?.stock ?? '?'}, ${String(offer?.priceMinor)} öre.`,
    );
    console.log(`Open it: xcrun simctl openurl booted "outfitly-dev://look/${lookId}"`);
  } else {
    await putPage(command === 'sold-out' ? 'OutOfStock' : 'InStock');
    const { rows } = await db.execute<{ n: number }>(
      sql`SELECT count(*)::int AS n FROM offers WHERE page_url = ${pageUrl}`,
    );
    console.log(`The demo page now says ${command}; ${String(rows[0]?.n ?? 0)} link(s) to it.`);
    console.log(`Check it now: pnpm prices:refresh --page ${pageUrl}`);
  }
} finally {
  await db.$client.end();
}
