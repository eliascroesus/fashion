import {
  and,
  type Db,
  eq,
  inArray,
  isNull,
  offers,
  priceRefreshRuns,
  priceRefreshSites,
  products,
  sql,
} from '@outfitly/db';
import { z } from 'zod';
import { nextUtcDay } from '../ai/photos.ts';
import { showableLook } from '../feed/cards.ts';
import type { JobQueue } from '../jobs.ts';
import { readSetting } from '../settings.ts';
import { queueLinkCheck } from './check.ts';
import { LinkFetchError, type NetworkPolicy } from './fetch.ts';
import {
  queueProductWork,
  readShopPage,
  samePhoto,
  saveLinkRead,
  type ShopPage,
} from './resolve.ts';
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
 * `goneAfter` checks in a row counts as sold out, unless most of a shop's
 * pages "went" at once (then a person should look). No AI is asked here.
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
const DAY_MS = 24 * HOUR_MS;
/** How often the job runs (its schedule in jobs.ts); the caps are spread over the runs left today. */
export const RUN_EVERY_MS = 10 * 60 * 1000;
/** A run stops starting new pages after this, so it never runs into the next one. */
const RUN_TIME_LIMIT_MS = 8 * 60 * 1000;
/** "Daily": read again once this long has passed (a little under a day, so runs can drift). */
const DAILY_MS = 20 * HOUR_MS;
const WEEKLY_MS = 7 * DAY_MS;
/** Not read successfully for this long: "in stock" is no longer claimed (stock unknown). */
const STALE_MS = 14 * DAY_MS;
/** Runs are kept this long (the caps only look at today). */
const KEEP_RUNS_DAYS = 90;
/** A shop with at least this many pages gone in one run, and most of its reads, is suspect. */
const SUSPECT_GONE = 3;

/** What a run counts. */
export const FINDINGS = [
  'ok',
  'moved',
  'gone',
  'blocked',
  'failed',
  'unreadable',
  'currencyChanged',
  'priceChanged',
  'soldOut',
  'backInStock',
  'wentStale',
] as const;
export type Finding = (typeof FINDINGS)[number];

type Outcome = 'ok' | 'moved' | 'blocked' | 'failed' | 'unreadable' | 'currency_changed';

export interface PageResult {
  outcome: Outcome | 'gone' | 'skipped';
  /** Links to the page saved or marked. */
  offers: number;
  priceChanged: number;
  soldOut: number;
  backInStock: number;
  wentStale: number;
  /** The shop should rest until then (turned us away, busy, or didn't answer). */
  restSiteUntil: Date | null;
  /** A gone page's links, not marked yet: the run decides (`markGone`, or unreadable if suspect). */
  gone: LiveOffer[] | null;
}

export interface RefreshDeps {
  db: Db;
  queue: JobQueue;
  /** Tests point names at a local shop. */
  network?: NetworkPolicy;
  /** Tests pass a fake clock and a sleep that moves it. */
  now?: () => Date;
  sleep?: (ms: number) => Promise<void>;
  /** A page whose check crashed (it's marked unreadable and the run goes on). */
  onError?: (error: unknown, pageUrl: string) => void;
  /** Most of a shop's pages "went" in one run: left as they were, for a person to look at. */
  onSuspectSite?: (site: string, gone: number, reads: number) => void;
}

export interface RunSummary {
  /** Null when another run was still going (nothing was done). */
  runId: string | null;
  reads: { savedOrPopular: number; others: number };
  found: Record<Finding, number>;
  /** Shops left alone this run because they're resting. */
  restingSites: string[];
  /** Shops whose pages "went" all at once this run: not counted as gone. */
  suspectSites: string[];
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

/** The site of a `page_url` in SQL, like `siteOf` (lower case, `www.` / `m.` left out). */
const PAGE_SITE = sql`regexp_replace(lower(substring(po.page_url from '^[A-Za-z][A-Za-z0-9+.-]*://([^/?#:]+)')), '^(www|m)\\.', '')`;

/**
 * Pages due for a check in one group, most important first (saved by more
 * people, then popular, then least recently checked): `important` = on a
 * saved or popular look, read over 20 hours ago; `others` = the rest, read
 * over a week ago. Pages found gone but not yet sold out come back daily in
 * either group, to settle it sooner. Only pages with a link on a shown look,
 * none in a failure's back-off (`refresh_due_at`), none of a resting shop.
 */
export async function duePages(
  db: Db,
  settings: PriceRefreshSettings,
  now: Date,
  group: 'important' | 'others',
  limit: number,
): Promise<DuePage[]> {
  if (limit <= 0) return [];
  const at = sql`${now.toISOString()}::timestamptz`;
  const daily = sql`${new Date(now.getTime() - DAILY_MS).toISOString()}::timestamptz`;
  const weekly = sql`${new Date(now.getTime() - WEEKLY_MS).toISOString()}::timestamptz`;
  const important = sql`(pw.savers > 0 OR pw.popular)`;
  const settling = sql`(po.gone BETWEEN 1 AND ${settings.goneAfter - 1} AND po.touched < ${daily})`;
  const inGroup =
    group === 'important'
      ? sql`${important} AND (po.touched < ${daily} OR ${settling})`
      : sql`NOT ${important} AND (po.touched < ${weekly} OR ${settling})`;
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
    SELECT po.page_url, ${important} AS important, pw.savers
      FROM page_offers po JOIN page_weight pw ON pw.page_url = po.page_url
     WHERE po.due AND ${inGroup}
       AND NOT EXISTS (SELECT 1 FROM price_refresh_sites rs
                        WHERE rs.site = ${PAGE_SITE} AND rs.rest_until > ${at})
     ORDER BY pw.savers DESC, pw.popular DESC, po.touched, po.page_url
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

/** Shops resting now. */
async function restingSites(db: Db, now: Date): Promise<string[]> {
  const rows = await db
    .select({ site: priceRefreshSites.site })
    .from(priceRefreshSites)
    .where(sql`${priceRefreshSites.restUntil} > ${now.toISOString()}::timestamptz`);
  return rows.map((r) => r.site);
}

function siteOfPage(pageUrl: string): string {
  return siteOf(new URL(pageUrl).hostname);
}

function emptyFindings(): Record<Finding, number> {
  return Object.fromEntries(FINDINGS.map((f) => [f, 0])) as Record<Finding, number>;
}

const FINDING_OF: Record<Outcome | 'gone', Finding> = {
  ok: 'ok',
  moved: 'moved',
  gone: 'gone',
  blocked: 'blocked',
  failed: 'failed',
  unreadable: 'unreadable',
  currency_changed: 'currencyChanged',
};

/**
 * One run, if no other is going (manual runs too: a lock held for the run):
 * picks the due pages within today's caps, reads them one at a time (at most
 * one read of a shop every `siteGapMs`; a shop that has to rest is skipped
 * for the rest of the run), then settles gone pages and logs the run (its
 * counts are written after every page, so a killed run's reads still count).
 * With `pageUrl`, reads just that page now, whatever is due (scripts).
 */
export async function runPriceRefresh(
  deps: RefreshDeps,
  options: { pageUrl?: string } = {},
): Promise<RunSummary> {
  const { db } = deps;
  const lockClient = await db.$client.connect();
  try {
    const { rows } = await lockClient.query<{ ok: boolean }>(
      "SELECT pg_try_advisory_lock(hashtext('price-refresh')) AS ok",
    );
    if (!rows[0]?.ok) {
      return {
        runId: null,
        reads: { savedOrPopular: 0, others: 0 },
        found: emptyFindings(),
        restingSites: [],
        suspectSites: [],
      };
    }
    try {
      return await runLocked(deps, options);
    } finally {
      await lockClient.query("SELECT pg_advisory_unlock(hashtext('price-refresh'))");
    }
  } finally {
    lockClient.release();
  }
}

async function runLocked(deps: RefreshDeps, options: { pageUrl?: string }): Promise<RunSummary> {
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

  const resting = options.pageUrl ? [] : await restingSites(db, started);
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
    const important = await duePages(db, settings, started, 'important', importantShare);
    const othersShare = Math.min(
      runShare(settings.othersPerDay - used.others, started, settings.maxPerRun),
      settings.maxPerRun - important.length,
    );
    const others = await duePages(db, settings, started, 'others', othersShare);
    picked = [...important, ...others];
  }

  const found = emptyFindings();
  const reads = { savedOrPopular: 0, others: 0 };
  const saveCounts = () =>
    db
      .update(priceRefreshRuns)
      .set({ readsSavedOrPopular: reads.savedOrPopular, readsOthers: reads.others, found })
      .where(eq(priceRefreshRuns.id, run.id));
  const lastRead = new Map<string, number>();
  const restingNow = new Set<string>();
  const perSite = new Map<string, { reads: number; gone: LiveOffer[][] }>();
  const suspectSites: string[] = [];
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
      let result: PageResult;
      try {
        result = await refreshPage(deps, page.pageUrl, settings, clock());
      } catch (error) {
        // A page that crashes its check stops nothing else: unreadable, retried after a back-off.
        deps.onError?.(error, page.pageUrl);
        result = await markPageUnreadable(db, page.pageUrl, clock()).catch(() => SKIPPED);
      }
      if (result.outcome === 'skipped') continue;
      if (page.important) reads.savedOrPopular += 1;
      else reads.others += 1;
      const tally = perSite.get(site) ?? { reads: 0, gone: [] };
      tally.reads += 1;
      perSite.set(site, tally);
      if (result.gone) {
        tally.gone.push(result.gone);
      } else {
        found[FINDING_OF[result.outcome]] += 1;
        found.priceChanged += result.priceChanged;
        found.soldOut += result.soldOut;
        found.backInStock += result.backInStock;
        found.wentStale += result.wentStale;
      }
      if (result.restSiteUntil) {
        restingNow.add(site);
        await restSite(db, site, result.outcome, result.restSiteUntil);
      } else if (result.outcome === 'ok' || result.outcome === 'moved') {
        // The shop answered and let us read: any rest is over.
        await db.delete(priceRefreshSites).where(eq(priceRefreshSites.site, site));
      }
      await saveCounts();
    }
  } finally {
    // Gone pages, shop by shop: most of a shop's pages gone at once is more likely a shop
    // change (new addresses, a consent wall) than a sell-out, so a person looks first.
    const now = clock();
    for (const [site, tally] of perSite) {
      if (tally.gone.length === 0) continue;
      const suspect = tally.gone.length >= SUSPECT_GONE && tally.gone.length * 2 > tally.reads;
      if (suspect) {
        suspectSites.push(site);
        deps.onSuspectSite?.(site, tally.gone.length, tally.reads);
      }
      for (const live of tally.gone) {
        if (suspect) {
          await markFailed(db, live, 'unreadable', now);
          found.unreadable += 1;
        } else {
          const marked = await markGone(db, live, settings, now);
          found.gone += 1;
          found.soldOut += marked.soldOut;
        }
      }
    }
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
  return { runId: run.id, reads, found, restingSites: resting, suspectSites };
}

const SKIPPED: PageResult = {
  outcome: 'skipped',
  offers: 0,
  priceChanged: 0,
  soldOut: 0,
  backInStock: 0,
  wentStale: 0,
  restSiteUntil: null,
  gone: null,
};

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
    return Math.min(DAY_MS, Math.max(error.retryAfterMs ?? 0, 0.5 * HOUR_MS * doubling));
  }
  if (error.problem === 'blocked') return Math.min(WEEKLY_MS, 6 * HOUR_MS * doubling);
  return Math.min(DAY_MS, HOUR_MS * doubling);
}

/** When a link is next due after a check that couldn't use its page (`failures` in a row). */
export function failureBackoff(
  outcome: 'blocked' | 'failed' | 'unreadable' | 'currency_changed',
  failures: number,
): number {
  const doubling = 2 ** Math.min(Math.max(failures - 1, 0), 10);
  const base = outcome === 'blocked' || outcome === 'failed' ? 6 * HOUR_MS : DAILY_MS;
  return Math.min(WEEKLY_MS, base * doubling);
}

interface LiveOffer {
  id: string;
  url: string;
  productId: string;
  priceMinor: number | null;
  currency: string | null;
  stock: 'in_stock' | 'out_of_stock' | 'unknown';
  lastCheckedAt: Date | null;
  refreshFailures: number;
  refreshGone: number;
  /** The shop photo its product has now. */
  photo: string | null;
}

async function liveOffers(db: Db, pageUrl: string): Promise<LiveOffer[]> {
  return db
    .select({
      id: offers.id,
      url: offers.url,
      productId: offers.productId,
      priceMinor: offers.priceMinor,
      currency: offers.currency,
      stock: offers.stock,
      lastCheckedAt: offers.lastCheckedAt,
      refreshFailures: offers.refreshFailures,
      refreshGone: offers.refreshGone,
      photo: products.imageUrl,
    })
    .from(offers)
    .innerJoin(products, eq(products.id, offers.productId))
    .where(and(eq(offers.pageUrl, pageUrl), isNull(offers.deletedAt)));
}

/**
 * Whether a read that found no product means the page is gone: the shop
 * redirected it (a real HTTP redirect) to another page of the same site that
 * doesn't carry the old address, like a category or the home page. A changed
 * canonical link alone, a redirect to another site (a consent or login wall,
 * another country) or one keeping the old path (`/sv/p/coat`,
 * `/login?return=/p/coat`) only means we couldn't read it.
 */
export function redirectedAway(requested: URL, finalUrl: URL): boolean {
  const from = new URL(requested.href);
  const to = new URL(finalUrl.href);
  from.hash = '';
  to.hash = '';
  if (from.href === to.href) return false;
  if (siteOf(from.hostname) !== siteOf(to.hostname)) return false;
  const oldPath = from.pathname.replace(/\/$/, '');
  if (oldPath === '') return false;
  let target = `${to.pathname}${to.search}`;
  try {
    target = decodeURIComponent(target);
  } catch {
    // Keep it encoded.
  }
  return !target.includes(oldPath);
}

/**
 * Checks one shop page and every live link to it. A read page saves every
 * link from the one read (price, stock, `last_checked_at`; history only when
 * the price changed; a page now showing another item moves the link and its
 * looks are checked again). A gone page is handed back for the run to mark
 * (`gone`). A shop that turned us away, was busy or didn't answer, a page we
 * couldn't read, or one in another currency changes nothing but the check's
 * own record (and a shop that turned us away rests).
 */
export async function refreshPage(
  deps: RefreshDeps,
  pageUrl: string,
  settings: PriceRefreshSettings,
  now: Date,
): Promise<PageResult> {
  const { db, queue } = deps;
  const live = await liveOffers(db, pageUrl);
  if (live.length === 0) return SKIPPED;
  const result: PageResult = { ...SKIPPED, offers: live.length };
  const failed = async (outcome: Exclude<Outcome, 'ok' | 'moved'>) => ({
    ...result,
    outcome,
    wentStale: await markFailed(db, live, outcome, now),
  });

  const requested = new URL(pageUrl);
  let page: ShopPage;
  try {
    page = await readShopPage(requested, deps.network);
  } catch (error) {
    if (!(error instanceof LinkFetchError)) throw error;
    if (error.problem === 'not_found') return { ...result, outcome: 'gone', gone: live };
    if (
      error.problem === 'blocked' ||
      error.problem === 'too_slow' ||
      error.problem === 'unreachable'
    ) {
      const outcome = error.problem === 'blocked' ? 'blocked' : 'failed';
      const [site] = await db
        .select({ strikes: priceRefreshSites.strikes })
        .from(priceRefreshSites)
        .where(eq(priceRefreshSites.site, siteOfPage(pageUrl)));
      const until = new Date(now.getTime() + siteRest(error, (site?.strikes ?? 0) + 1));
      return { ...(await failed(outcome)), restSiteUntil: until };
    }
    return failed('unreadable');
  }
  const product = page.product;
  if (!product) {
    if (redirectedAway(requested, page.finalUrl)) {
      return { ...result, outcome: 'gone', gone: live };
    }
    return failed('unreadable');
  }
  // Shops show prices in the reader's currency (where our server is, a CDN's guess): a
  // switch isn't a price change, so the link keeps what it had until a person looks.
  if (
    product.currency !== null &&
    live.some((o) => o.currency !== null && o.currency !== product.currency)
  ) {
    return failed('currency_changed');
  }

  const moved: string[] = [];
  for (const offer of live) {
    // The same shop photo with another query (sizes, cache-busting) isn't a new photo.
    const photo = samePhoto(offer.photo, product.imageUrl) ? offer.photo : product.imageUrl;
    const saved = await saveLinkRead(
      db,
      {
        url: offer.url,
        pageUrl: page.pageUrl,
        product: { ...product, imageUrl: photo },
        truncated: page.truncated,
      },
      now,
    );
    await queueProductWork(queue, db, saved.productId, saved.copyPhoto);
    for (const lookItemId of saved.recheck) await queueLinkCheck(queue, lookItemId);
    if (saved.productId !== offer.productId) moved.push(offer.id);
    const known = product.priceMinor !== null && product.currency !== null;
    const wasKnown = offer.priceMinor !== null && offer.currency !== null;
    if (known && wasKnown && product.priceMinor !== offer.priceMinor) result.priceChanged += 1;
    if (offer.stock !== 'out_of_stock' && product.stock === 'out_of_stock') result.soldOut += 1;
    if (offer.stock === 'out_of_stock' && product.stock !== 'out_of_stock') {
      result.backInStock += 1;
    }
  }
  const checked = { refreshTriedAt: now, refreshDueAt: new Date(now.getTime() + DAILY_MS) };
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
    await db
      .update(offers)
      .set({ ...checked, refreshOutcome: 'moved' })
      .where(inArray(offers.id, moved));
  }
  return { ...result, outcome: moved.length > 0 ? 'moved' : 'ok' };
}

/**
 * The page is gone: one more in a row (failures don't break the row, a good
 * read does); at `goneAfter` its links count as sold out and are then only
 * looked at weekly, in case the page comes back.
 */
export async function markGone(
  db: Db,
  live: LiveOffer[],
  settings: PriceRefreshSettings,
  now: Date,
): Promise<{ soldOut: number }> {
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
        refreshDueAt: new Date(now.getTime() + (nowSoldOut ? WEEKLY_MS : DAILY_MS)),
      })
      .where(eq(offers.id, offer.id));
  }
  return { soldOut };
}

/**
 * Couldn't use the page: nothing about the item changes, only the check's own
 * record. A link not read for two weeks no longer says "in stock" (unknown):
 * a shop that keeps us out could have sold it long ago. Returns how many went
 * stale now.
 */
async function markFailed(
  db: Db,
  live: LiveOffer[],
  outcome: Exclude<Outcome, 'ok' | 'moved'>,
  now: Date,
): Promise<number> {
  let wentStale = 0;
  for (const offer of live) {
    const failures = offer.refreshFailures + 1;
    const stale =
      offer.stock === 'in_stock' &&
      (offer.lastCheckedAt === null || now.getTime() - offer.lastCheckedAt.getTime() > STALE_MS);
    if (stale) wentStale += 1;
    await db
      .update(offers)
      .set({
        refreshTriedAt: now,
        refreshOutcome: outcome,
        refreshFailures: failures,
        refreshDueAt: new Date(now.getTime() + failureBackoff(outcome, failures)),
        ...(stale ? { stock: 'unknown' as const } : {}),
      })
      .where(eq(offers.id, offer.id));
  }
  return wentStale;
}

/** After a crash checking a page: its links are marked unreadable (with the usual back-off). */
async function markPageUnreadable(db: Db, pageUrl: string, now: Date): Promise<PageResult> {
  const live = await liveOffers(db, pageUrl);
  if (live.length === 0) return SKIPPED;
  const wentStale = await markFailed(db, live, 'unreadable', now);
  return { ...SKIPPED, outcome: 'unreadable', offers: live.length, wentStale };
}
