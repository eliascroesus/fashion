// Runs the price and stock check (Step 3.9) once, now, against the database in .env (the API also
// runs it every 10 minutes). From the repo root:
//   pnpm prices:refresh                  one run: the due pages within today's caps
//   pnpm prices:refresh --page <url>     just that shop page (its `page_url`), due or not
//   pnpm prices:refresh --due            lists what's due, reads nothing
// Photo copies and link checks it needs are queued for the API's workers.
import { createDb } from '@outfitly/db';
import { loadConfig } from '../src/config.ts';
import { createJobQueue } from '../src/jobs.ts';
import { duePages, priceRefreshSettings, runPriceRefresh } from '../src/links/refresh.ts';

const args = process.argv.slice(2);
const pageArg = args.includes('--page') ? args[args.indexOf('--page') + 1] : undefined;
if (args.includes('--page') && !pageArg) {
  console.error('Usage: pnpm prices:refresh [--page <url>] [--due]');
  process.exit(1);
}

const config = loadConfig();
const db = createDb(config.DATABASE_URL, { caCert: config.DATABASE_CA_CERT });
const boss = createJobQueue(config.DATABASE_URL, config.DATABASE_CA_CERT);
try {
  if (args.includes('--due')) {
    const due = await duePages(db, await priceRefreshSettings(db), new Date(), 200);
    console.table(due);
  } else {
    await boss.start();
    const started = performance.now();
    const summary = await runPriceRefresh({ db, queue: boss }, { pageUrl: pageArg });
    console.log(`Done in ${String(Math.round(performance.now() - started))} ms:`);
    console.log(JSON.stringify(summary, null, 2));
  }
} finally {
  await boss.stop({ graceful: true, close: true }).catch(() => undefined);
  await db.$client.end();
}
