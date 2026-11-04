// Feed speed check (target: p95 under 300 ms). From the repo root:
//   pnpm feed:speed                 logged out, over HTTP against the staging API
//   pnpm feed:speed --direct        logged in as @loadtest.01 (follows, taste, 300 seen looks) and
//                                   @loadtest.07 (taste no look matches): runs the feed code
//                                   against DATABASE_URL from this computer
//   --url <api base>  (default https://outfitly-api-staging.fly.dev)   --runs N  (default 30)
// Needs the fake looks (pnpm seed:fake-looks); `--remove` also clears the viewer's follows/taste/seen.
import { createDb, type Db, follows, inArray, looks, seen, sql, tasteProfiles } from '@outfitly/db';
import { type FeedPage, feedPageSchema } from '@outfitly/shared';
import { loadConfig, r2Config } from '../src/config.ts';
import { followingPage } from '../src/feed/following.ts';
import { forYouPage } from '../src/feed/for-you.ts';
import { R2Storage } from '../src/storage.ts';
import { FAKE_AUTHORS } from './seed/fake-looks.ts';

const args = process.argv.slice(2);
const option = (name: string) => (args.includes(name) ? args[args.indexOf(name) + 1] : undefined);
const runs = Number(option('--runs') ?? 30);
const baseUrl = option('--url') ?? 'https://outfitly-api-staging.fly.dev';
const NEXT_PAGES = 4;

type Timed = { ms: number; page: FeedPage };

async function timed(fn: () => Promise<FeedPage>): Promise<Timed> {
  const started = performance.now();
  const page = await fn();
  return { ms: performance.now() - started, page };
}

function report(label: string, samples: number[]): void {
  const sorted = [...samples].sort((a, b) => a - b);
  const at = (p: number) => sorted[Math.min(sorted.length - 1, Math.ceil(p * sorted.length) - 1)];
  const ms = (v: number | undefined) => `${String(Math.round(v ?? 0))} ms`;
  console.log(
    `${label.padEnd(22)} p50 ${ms(at(0.5))} · p95 ${ms(at(0.95))} · max ${ms(sorted.at(-1))} (${String(sorted.length)} requests)`,
  );
}

/** Page 1 then NEXT_PAGES more, `runs` times; checks that no look repeats within a run. */
async function measure(
  label: string,
  pages: number,
  fetchPage: (cursor: string | undefined) => Promise<FeedPage>,
): Promise<void> {
  const first: number[] = [];
  const later: number[] = [];
  for (let run = 0; run < runs; run++) {
    const ids = new Set<string>();
    let cursor: string | undefined;
    for (let p = 0; p <= pages; p++) {
      const { ms, page } = await timed(() => fetchPage(cursor));
      (p === 0 ? first : later).push(ms);
      for (const item of page.items) {
        if (ids.has(item.id)) throw new Error(`${label}: look ${item.id} repeated`);
        ids.add(item.id);
      }
      if (!page.nextCursor) break;
      cursor = page.nextCursor;
    }
  }
  report(`${label}, page 1`, first);
  if (later.length > 0) report(`${label}, next pages`, later);
}

async function overHttp(): Promise<void> {
  const get = async (cursor: string | undefined) => {
    const url = new URL('/v1/feed/for-you', baseUrl);
    if (cursor) url.searchParams.set('cursor', cursor);
    const res = await fetch(url);
    if (!res.ok) throw new Error(`${url.toString()} → ${String(res.status)} ${await res.text()}`);
    return feedPageSchema.parse(await res.json());
  };
  // Wake a sleeping staging machine and warm its connections first.
  const health = await fetch(new URL('/v1/health', baseUrl));
  if (!health.ok) throw new Error(`API not healthy: ${String(health.status)}`);
  for (let i = 0; i < 3; i++) await get(undefined);
  console.log(`Logged out, over HTTP from this computer to ${baseUrl}:`);
  await measure('For You', NEXT_PAGES, get);
}

/** @loadtest.01 follows five other test posters, picked Streetwear and has seen 300 looks. */
async function prepareViewer(db: Db): Promise<string> {
  const [viewer, ...others] = FAKE_AUTHORS.slice(0, 6).map((a) => a.id);
  if (!viewer) throw new Error('no fake authors');
  await db
    .insert(follows)
    .values(others.map((id) => ({ followerProfileId: viewer, followedProfileId: id })))
    .onConflictDoNothing();
  await db
    .insert(tasteProfiles)
    .values({ profileId: viewer, styles: ['streetwear'] })
    .onConflictDoUpdate({ target: tasteProfiles.profileId, set: { styles: ['streetwear'] } });
  const sample = await db
    .select({ id: looks.id })
    .from(looks)
    .where(
      inArray(
        looks.authorProfileId,
        FAKE_AUTHORS.map((a) => a.id),
      ),
    )
    .orderBy(sql`random()`)
    .limit(300);
  await db
    .insert(seen)
    .values(sample.map(({ id }) => ({ profileId: viewer, lookId: id })))
    .onConflictDoNothing();
  return viewer;
}

async function direct(): Promise<void> {
  const config = loadConfig();
  if (config.NODE_ENV === 'production')
    throw new Error('Refusing to run with NODE_ENV=production.');
  const db = createDb(config.DATABASE_URL, { caCert: config.DATABASE_CA_CERT });
  try {
    const deps = { db, storage: new R2Storage(r2Config(config)) };
    const viewer = await prepareViewer(db);
    for (let i = 0; i < 3; i++) await forYouPage(deps, viewer, undefined);
    const ping = performance.now();
    await db.execute(sql`SELECT 1`);
    console.log(
      `Logged in as @loadtest.01, feed code on this computer against the database (one round trip ≈ ${String(Math.round(performance.now() - ping))} ms):`,
    );
    await measure('For You', NEXT_PAGES, (cursor) => forYouPage(deps, viewer, cursor));
    await measure('Following', 2, (cursor) => followingPage(deps, viewer, cursor));

    // Harder case for the taste pool: the style the fewest looks carry.
    const { rows } = await db.execute<{ style: string }>(sql`
      SELECT s.style::text AS style FROM looks l, unnest(l.style_tags) AS s(style)
       GROUP BY s.style ORDER BY count(*) LIMIT 1`);
    const rarest = rows[0]?.style ?? 'colorful';
    const picky = FAKE_AUTHORS[6]?.id ?? '';
    await db
      .insert(tasteProfiles)
      .values({ profileId: picky, styles: [rarest] })
      .onConflictDoUpdate({ target: tasteProfiles.profileId, set: { styles: [rarest] } });
    console.log(`Logged in as @loadtest.07, who picked the rarest style (${rarest}):`);
    await measure('For You', 0, (cursor) => forYouPage(deps, picky, cursor));
  } finally {
    await db.$client.end();
  }
}

if (!Number.isInteger(runs) || runs < 1) {
  console.error('Usage: pnpm feed:speed [--direct] [--url <api>] [--runs N]');
  process.exit(1);
}
await (args.includes('--direct') ? direct() : overHttp());
