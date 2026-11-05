import {
  and,
  type Db,
  eq,
  inArray,
  isNull,
  offers,
  priceRefreshRuns,
  priceRefreshSites,
  sql,
} from '@outfitly/db';
import { z } from 'zod';
import { nextUtcDay } from '../ai/photos.ts';
import { showableLook } from '../feed/cards.ts';
import type { JobQueue } from '../jobs.ts';
import { readSetting } from '../settings.ts';
import { queueLinkCheck } from './check.ts';
import { LinkFetchError, type NetworkPolicy } from './fetch.ts';
import { queueProductWork, readShopPage, saveLinkRead, type ShopPage } from './resolve.ts';
import { siteOf } from './urls.ts';

/**
 * The price and stock check (Step 3.9). Every 10 minutes a run reads a few
 * shop pages again: daily the pages of links on saved or popular looks, weekly
 * every other link on a shown look; links on no shown look aren't checked.
 * Each page is read once (at its `page_url`, never the poster's affiliate
 * link) and every link to it is saved from that one read through
 * `saveLinkRead`, so the paste flow's rules apply: a page that now shows
 * another item moves the link and its looks are checked again (Step 3.5). Two
 * daily caps, spread over the day; at most one read of a shop every
 * `siteGapMs`; a shop that turns us away, is busy or doesn't answer rests,
 * and that is never read as sold out or a price change. A page gone
 * `goneAfter` checks in a row counts as sold out. No AI is asked here.
 */

/** The `settings` row with the caps and timings (inserted by migration 0019). */
export const PRICE_REFRESH_SETTING = 'price_refresh';

export const priceRefreshSettingsSchema = z.strictObject({
  /** Pages read per UTC day for links on saved or popular looks (checked daily). */
  savedOrPopularPerDay: z.number().int().min(0).max(100_000),
  /** Pages read per UTC day for the other links on shown looks (checked weekly). */
  othersPerDay: z.number().int().min(0).max(100_000),
  /** This many most popular looks count as popular. */
  popularLooks: z.number().int().min(0).max(10_000),
  /** Most pages one run reads. */
  maxPerRun: z.number().int().min(1).max(500),
  /** Least time between two reads of one shop (site). */
  siteGapMs: z.number().int().min(1000).max(60_000),
  /** A page gone this many checks in a row: its links count as sold out. */
  goneAfter: z.number().int().min(1).max(30),
});
export type PriceRefreshSettings = z.infer<typeof priceRefreshSettingsSchema>;

export function priceRefreshSettings(db: Db): Promise<PriceRefreshSettings> {
  return readSetting(db, PRICE_REFRESH_SETTING, priceRefreshSettingsSchema);
}

const HOUR_MS = 60 * 60 * 1000;
/** How often the job runs (its schedule in jobs.ts); the caps are spread over the runs left today. */
export const RUN_EVERY_MS = 10 * 60 * 1000;
/** A run stops starting new pages after this, so it never runs into the next one. */
const RUN_TIME_LIMIT_MS = 8 * 60 * 1000;
/** "Daily": read again once this long has passed (a little under a day, so runs can drift). */
const DAILY_MS = 20 * HOUR_MS;
const WEEKLY_MS = 7 * 24 * HOUR_MS;
/** Runs are kept this long (the caps only look at today). */
const KEEP_RUNS_DAYS = 90;

/** What one page's check found, for the run's counts. */
export type PageFinding = (typeof FINDINGS)[number];
const FINDINGS = [
  'ok',
  'priceChanged',
  'soldOut',
  'backInStock',
  'moved',
  'gone',
  'blocked',
  'failed',
  'unreadable',
] as const;

export interface PageResult {
  outcome: 'ok' | 'moved' | 'gone' | 'blocked' | 'failed' | 'unreadable' | 'skipped';
  /** Links to the page saved or marked. */
  offers: number;
  priceChanged: number;
  soldOut: number;
  backInStock: number;
  /** The shop should rest until then (turned us away, busy, or didn't answer). */
  restSiteUntil: Date | null;
}

export interface RefreshDeps {
  db: Db;
  queue: JobQueue;
  /** Tests point names at a local shop. */
  network?: NetworkPolicy;
  /** Tests pass a fake clock and a sleep that moves it. */
  now?: () => Date;
  sleep?: (ms: number) => Promise<void>;
}

export interface RunSummary {
  runId: string;
  reads: { savedOrPopular: number; others: number };
  found: Record<PageFinding, number>;
  /** Shops left alone this run because they're resting. */
  restingSites: string[];
}

const realSleep = (ms: number) =>
  new Promise<void>((resolve) => {
    setTimeout(resolve, ms);
  });

/** A page waiting for its check, most important first. */
export interface DuePage {
  pageUrl: string;
  /** On a saved or popular look: checked daily, from the first cap. */
  important: boolean;
  savers: number;
}

/**
 * Pages due for a check, most important first (saved by more people, then
 * popular, then least recently checked): important ones read over 20 hours
 * ago, the rest over a week ago, and pages found gone but not yet counted as
 * sold out daily, to settle it sooner. Only pages with a link on a shown look,
 * and none in a failure's back-off (`refresh_due_at`).
 */
export async function duePages(
  db: Db,
  settings: PriceRefreshSettings,
  now: Date,
  limit: number,
): Promise<DuePage[]> {
  const at = sql`${now.toISOString()}::timestamptz`;
  const daily = sql`${new Date(now.getTime() - DAILY_MS).toISOString()}::timestamptz`;
  const weekly = sql`${new Date(now.getTime() - WEEKLY_MS).toISOString()}::timestamptz`;
  const { rows } = await db.execute<{ page_url: string; important: boolean; savers: number }>(sql`
    WITH shown AS (
      SELECT DISTINCT li.offer_id, li.look_id
        FROM look_items li JOIN looks l ON l.id = li.look_id
       WHERE li.status = 'verified' AND li.deleted_at IS NULL
         AND ${showableLook(sql`l`)} AND l.published_at <= now()
    ), popular AS (
      SELECT l.id FROM looks l
       WHERE ${showableLook(sql`l`)} AND l.published_at <= now()
       ORDER BY l.popularity_score DESC, l.id
       LIMIT ${settings.popularLooks}
    ), savers AS (
      SELECT x.look_id, count(DISTINCT x.profile_id)::int AS n
        FROM (SELECT s.look_id, s.profile_id FROM saves s WHERE s.deleted_at IS NULL
              UNION ALL
              SELECT bi.look_id, b.profile_id
                FROM board_items bi JOIN boards b ON b.id = bi.board_id
               WHERE bi.deleted_at IS NULL AND b.deleted_at IS NULL) x
       WHERE x.look_id IN (SELECT look_id FROM shown)
       GROUP BY x.look_id
    ), page_offers AS (
      SELECT o.page_url,
             min(coalesce(greatest(o.last_checked_at, o.refresh_tried_at),
                          '-infinity'::timestamptz)) AS touched,
             bool_and(o.refresh_due_at IS NULL OR o.refresh_due_at <= ${at}) AS due,
             max(o.refresh_gone) AS gone
        FROM offers o
       WHERE o.deleted_at IS NULL AND o.id IN (SELECT offer_id FROM shown)
       GROUP BY o.page_url
    ), page_weight AS (
      SELECT pl.page_url, coalesce(sum(sv.n), 0)::int AS savers,
             bool_or(p.id IS NOT NULL) AS popular
        FROM (SELECT DISTINCT o.page_url, sh.look_id
                FROM offers o JOIN shown sh ON sh.offer_id = o.id
               WHERE o.deleted_at IS NULL) pl
        LEFT JOIN savers sv ON sv.look_id = pl.look_id
        LEFT JOIN popular p ON p.id = pl.look_id
       GROUP BY pl.page_url
    )
    SELECT po.page_url, (pw.savers > 0 OR pw.popular) AS important, pw.savers
      FROM page_offers po JOIN page_weight pw ON pw.page_url = po.page_url
     WHERE po.due
       AND (((pw.savers > 0 OR pw.popular) AND po.touched < ${daily})
            OR po.touched < ${weekly}
            OR (po.gone BETWEEN 1 AND ${settings.goneAfter - 1} AND po.touched < ${daily}))
     ORDER BY (pw.savers > 0 OR pw.popular) DESC, pw.savers DESC, pw.popular DESC,
              po.touched, po.page_url
     LIMIT ${limit}`);
  return rows.map((r) => ({ pageUrl: r.page_url, important: r.important, savers: r.savers }));
}

/** Pages read so far today (UTC), per cap. */
async function readsToday(db: Db, now: Date): Promise<{ important: number; others: number }> {
  const { rows } = await db.execute<{ important: number; others: number }>(sql`
    SELECT coalesce(sum(reads_saved_or_popular), 0)::int AS important,
           coalesce(sum(reads_others), 0)::int AS others
      FROM price_refresh_runs
     WHERE created_at >= date_trunc('day', ${now.toISOString()}::timestamptz, 'UTC')`);
  return rows[0] ?? { important: 0, others: 0 };
}

/** This run's share of what's left of a cap today: spread evenly over the runs left. */
export function runShare(left: number, now: Date, maxPerRun: number): number {
  if (left <= 0) return 0;
  const runsLeft = Math.max(
    1,
    Math.ceil((nextUtcDay(now).getTime() - now.getTime()) / RUN_EVERY_MS),
  );
  return Math.min(maxPerRun, Math.ceil(left / runsLeft));
}

/** Shops resting now, and until when. */
async function restingSites(db: Db, now: Date): Promise<Map<string, Date>> {
  const rows = await db
    .select({ site: priceRefreshSites.site, until: priceRefreshSites.restUntil })
    .from(priceRefreshSites)
    .where(sql`${priceRefreshSites.restUntil} > ${now.toISOString()}::timestamptz`);
  return new Map(rows.map((r) => [r.site, r.until]));
}

function siteOfPage(pageUrl: string): string {
  return siteOf(new URL(pageUrl).hostname);
}

/**
 * One run: picks the due pages within today's caps, reads them one at a time
 * (at most one read of a shop every `siteGapMs`; a shop that has to rest is
 * skipped for the rest of the run) and logs the run. With `pageUrl`, reads
 * just that page now, whatever is due (scripts; still logged and counted).
 */
export async function runPriceRefresh(
  deps: RefreshDeps,
  options: { pageUrl?: string } = {},
): Promise<RunSummary> {
  const { db } = deps;
  const clock = deps.now ?? (() => new Date());
  const sleep = deps.sleep ?? realSleep;
  const started = clock();
  const settings = await priceRefreshSettings(db);

  await db
    .delete(priceRefreshRuns)
    .where(sql`${priceRefreshRuns.createdAt} < now() - make_interval(days => ${KEEP_RUNS_DAYS})`);
  const [run] = await db
    .insert(priceRefreshRuns)
    .values({ createdAt: started })
    .returning({ id: priceRefreshRuns.id });
  if (!run) throw new Error('Run not logged.');

  const resting = await restingSites(db, started);
  let picked: DuePage[];
  if (options.pageUrl) {
    picked = [{ pageUrl: options.pageUrl, important: true, savers: 0 }];
  } else {
    const used = await readsToday(db, started);
    const importantShare = runShare(
      settings.savedOrPopularPerDay - used.important,
      started,
      settings.maxPerRun,
    );
    const othersShare = runShare(settings.othersPerDay - used.others, started, settings.maxPerRun);
    // Read more than needed: pages of resting shops are skipped.
    const due = (await duePages(db, settings, started, settings.maxPerRun * 10)).filter(
      (page) => !resting.has(siteOfPage(page.pageUrl)),
    );
    const important = due.filter((p) => p.important).slice(0, importantShare);
    const others = due
      .filter((p) => !p.important)
      .slice(0, Math.min(othersShare, settings.maxPerRun - important.length));
    picked = [...important, ...others];
  }

  const found = Object.fromEntries(FINDINGS.map((f) => [f, 0])) as Record<PageFinding, number>;
  const reads = { savedOrPopular: 0, others: 0 };
  const lastRead = new Map<string, number>();
  const restingNow = new Set(options.pageUrl ? [] : resting.keys());
  const waiting = [...picked];
  try {
    while (waiting.length > 0) {
      if (clock().getTime() - started.getTime() > RUN_TIME_LIMIT_MS) break;
      for (let i = waiting.length - 1; i >= 0; i--) {
        const page = waiting[i];
        if (page && restingNow.has(siteOfPage(page.pageUrl))) waiting.splice(i, 1);
      }
      const at = clock().getTime();
      const readyAt = (page: DuePage) =>
        (lastRead.get(siteOfPage(page.pageUrl)) ?? -Infinity) + settings.siteGapMs;
      const index = waiting.findIndex((page) => readyAt(page) <= at);
      if (index === -1) {
        if (waiting.length === 0) break;
        await sleep(Math.max(0, Math.min(...waiting.map(readyAt)) - at));
        continue;
      }
      const [page] = waiting.splice(index, 1);
      if (!page) break;
      const site = siteOfPage(page.pageUrl);
      lastRead.set(site, clock().getTime());
      const result = await refreshPage(deps, page.pageUrl, settings, clock());
      if (result.outcome === 'skipped') continue;
      if (page.important) reads.savedOrPopular += 1;
      else reads.others += 1;
      found[result.outcome] += 1;
      found.priceChanged += result.priceChanged;
      found.soldOut += result.soldOut;
      found.backInStock += result.backInStock;
      if (result.restSiteUntil) {
        restingNow.add(site);
        await restSite(db, site, result.outcome, result.restSiteUntil);
      } else if (result.outcome !== 'unreadable' && result.outcome !== 'gone') {
        // The shop answered and let us read: any rest is over.
        await db.delete(priceRefreshSites).where(eq(priceRefreshSites.site, site));
      }
    }
  } finally {
    await db
      .update(priceRefreshRuns)
      .set({
        finishedAt: clock(),
        readsSavedOrPopular: reads.savedOrPopular,
        readsOthers: reads.others,
        found,
      })
      .where(eq(priceRefreshRuns.id, run.id));
  }
  return { runId: run.id, reads, found, restingSites: [...resting.keys()] };
}

/** A shop rests: until `until`, or longer each time in a row (`strikes`). */
async function restSite(db: Db, site: string, problem: string, until: Date): Promise<void> {
  await db
    .insert(priceRefreshSites)
    .values({ site, restUntil: until, lastProblem: problem })
    .onConflictDoUpdate({
      target: priceRefreshSites.site,
      set: {
        restUntil: until,
        lastProblem: problem,
        strikes: sql`${priceRefreshSites.strikes} + 1`,
      },
    });
}

/** How long a shop rests after turning us away (longer each time in a row, at most a week). */
export function siteRest(error: LinkFetchError, strikes: number): number {
  const doubling = 2 ** Math.min(Math.max(strikes - 1, 0), 10);
  if (error.httpStatus === 429 || error.httpStatus === 503) {
    return Math.min(24 * HOUR_MS, Math.max(error.retryAfterMs ?? 0, 0.5 * HOUR_MS * doubling));
  }
  if (error.problem === 'blocked') return Math.min(7 * 24 * HOUR_MS, 6 * HOUR_MS * doubling);
  return Math.min(24 * HOUR_MS, HOUR_MS * doubling);
}

/** When a link is next due after a check that couldn't read its page (`failures` in a row). */
export function failureBackoff(outcome: 'blocked' | 'failed' | 'unreadable', failures: number) {
  const doubling = 2 ** Math.min(Math.max(failures - 1, 0), 10);
  const base = outcome === 'unreadable' ? DAILY_MS : 6 * HOUR_MS;
  return Math.min(WEEKLY_MS, base * doubling);
}

type LiveOffer = Pick<
  typeof offers.$inferSelect,
  | 'id'
  | 'url'
  | 'productId'
  | 'priceMinor'
  | 'currency'
  | 'stock'
  | 'refreshFailures'
  | 'refreshGone'
>;

/**
 * Checks one shop page and every live link to it. A read page saves every
 * link from the one read (price, stock, `last_checked_at`; history only when
 * the price changed; a page now showing another item moves the link and its
 * looks are checked again). A page that's gone counts toward sold out; a shop
 * that turned us away, was busy or didn't answer changes nothing but the
 * check's own record (and the shop rests).
 */
export async function refreshPage(
  deps: RefreshDeps,
  pageUrl: string,
  settings: PriceRefreshSettings,
  now: Date,
): Promise<PageResult> {
  const { db, queue } = deps;
  const live: LiveOffer[] = await db
    .select({
      id: offers.id,
      url: offers.url,
      productId: offers.productId,
      priceMinor: offers.priceMinor,
      currency: offers.currency,
      stock: offers.stock,
      refreshFailures: offers.refreshFailures,
      refreshGone: offers.refreshGone,
    })
    .from(offers)
    .where(and(eq(offers.pageUrl, pageUrl), isNull(offers.deletedAt)));
  const none: PageResult = {
    outcome: 'skipped',
    offers: 0,
    priceChanged: 0,
    soldOut: 0,
    backInStock: 0,
    restSiteUntil: null,
  };
  if (live.length === 0) return none;

  let page: ShopPage;
  try {
    page = await readShopPage(new URL(pageUrl), deps.network);
  } catch (error) {
    if (!(error instanceof LinkFetchError)) throw error;
    if (error.problem === 'not_found') return markGone(db, live, settings, now);
    if (
      error.problem === 'blocked' ||
      error.problem === 'too_slow' ||
      error.problem === 'unreachable'
    ) {
      const outcome = error.problem === 'blocked' ? 'blocked' : 'failed';
      await markFailed(db, live, outcome, now);
      const [site] = await db
        .select({ strikes: priceRefreshSites.strikes })
        .from(priceRefreshSites)
        .where(eq(priceRefreshSites.site, siteOfPage(pageUrl)));
      const until = new Date(now.getTime() + siteRest(error, (site?.strikes ?? 0) + 1));
      return { ...none, outcome, offers: live.length, restSiteUntil: until };
    }
    await markFailed(db, live, 'unreadable', now);
    return { ...none, outcome: 'unreadable', offers: live.length };
  }
  if (!page.product) {
    // Sent on to a page without a product (a removed item's category page): gone. The same
    // page without product data (a redesign, a broken page) only couldn't be read.
    if (page.pageUrl !== pageUrl) return markGone(db, live, settings, now);
    await markFailed(db, live, 'unreadable', now);
    return { ...none, outcome: 'unreadable', offers: live.length };
  }

  const product = page.product;
  const result: PageResult = { ...none, outcome: 'ok', offers: live.length };
  const moved: string[] = [];
  for (const offer of live) {
    const saved = await saveLinkRead(
      db,
      { url: offer.url, pageUrl: page.pageUrl, product, truncated: page.truncated },
      now,
    );
    await queueProductWork(queue, db, saved.productId, saved.copyPhoto);
    for (const lookItemId of saved.recheck) await queueLinkCheck(queue, lookItemId);
    if (saved.productId !== offer.productId) moved.push(offer.id);
    const known = product.priceMinor !== null && product.currency !== null;
    const wasKnown = offer.priceMinor !== null && offer.currency !== null;
    if (
      known &&
      wasKnown &&
      (product.priceMinor !== offer.priceMinor || product.currency !== offer.currency)
    ) {
      result.priceChanged += 1;
    }
    if (offer.stock !== 'out_of_stock' && product.stock === 'out_of_stock') result.soldOut += 1;
    if (offer.stock === 'out_of_stock' && product.stock !== 'out_of_stock') {
      result.backInStock += 1;
    }
  }
  const checked = {
    refreshTriedAt: now,
    refreshFailures: 0,
    refreshGone: 0,
    refreshDueAt: new Date(now.getTime() + DAILY_MS),
  };
  await db
    .update(offers)
    .set({ ...checked, refreshOutcome: 'ok' })
    .where(
      inArray(
        offers.id,
        live.map((o) => o.id),
      ),
    );
  if (moved.length > 0) {
    result.outcome = 'moved';
    await db
      .update(offers)
      .set({ ...checked, refreshOutcome: 'moved' })
      .where(inArray(offers.id, moved));
  }
  return result;
}

/** The page is gone: one more in a row; at `goneAfter` its links count as sold out. */
async function markGone(
  db: Db,
  live: LiveOffer[],
  settings: PriceRefreshSettings,
  now: Date,
): Promise<PageResult> {
  let soldOut = 0;
  for (const offer of live) {
    const gone = offer.refreshGone + 1;
    const nowSoldOut = gone >= settings.goneAfter;
    if (nowSoldOut && offer.stock !== 'out_of_stock') soldOut += 1;
    await db
      .update(offers)
      .set({
        refreshTriedAt: now,
        refreshOutcome: 'gone',
        refreshFailures: offer.refreshFailures + 1,
        refreshGone: gone,
        ...(nowSoldOut ? { stock: 'out_of_stock' as const } : {}),
        refreshDueAt: new Date(now.getTime() + DAILY_MS),
      })
      .where(eq(offers.id, offer.id));
  }
  return {
    outcome: 'gone',
    offers: live.length,
    priceChanged: 0,
    soldOut,
    backInStock: 0,
    restSiteUntil: null,
  };
}

/** Couldn't read the page: nothing about the item changes, only the check's own record. */
async function markFailed(
  db: Db,
  live: LiveOffer[],
  outcome: 'blocked' | 'failed' | 'unreadable',
  now: Date,
): Promise<void> {
  for (const offer of live) {
    const failures = offer.refreshFailures + 1;
    await db
      .update(offers)
      .set({
        refreshTriedAt: now,
        refreshOutcome: outcome,
        refreshFailures: failures,
        refreshDueAt: new Date(now.getTime() + failureBackoff(outcome, failures)),
      })
      .where(eq(offers.id, offer.id));
  }
}
