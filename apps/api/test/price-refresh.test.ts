import {
  aiCalls,
  boardItems,
  boards,
  eq,
  inArray,
  lookItems,
  looks,
  offers,
  priceRefreshRuns,
  priceRefreshSites,
  products,
  saves,
  settings,
  sql,
} from '@outfitly/db';
import { piecesTotal } from '@outfitly/shared';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { checkLookItem, LINK_CHECK_QUEUES } from '../src/links/check.ts';
import { LinkFetchError, retryAfterMs } from '../src/links/fetch.ts';
import {
  duePages,
  failureBackoff,
  PRICE_REFRESH_SETTING,
  type PriceRefreshSettings,
  priceRefreshSettings,
  type RefreshDeps,
  runPriceRefresh,
  runShare,
  siteRest,
} from '../src/links/refresh.ts';
import { readShopLink, saveLinkRead } from '../src/links/resolve.ts';
import {
  attachDemoPiece,
  DEMO_PREFIX,
  demoPageHtml,
  removeDemoPieces,
} from '../scripts/seed/refresh-demo.ts';
import { lookDetail } from '../src/looks.ts';
import { forgetCachedSettings } from '../src/settings.ts';
import { createAuthor, createLook } from './feed-fixtures.ts';
import { createTestContext, type TestContext } from './helpers.ts';
import { type LocalShop, page, redirect, startLocalShop } from './local-shop.ts';

let ctx: TestContext;
let shop: LocalShop;
let author: string;
let defaults: PriceRefreshSettings;

/** The clock the runs see; sleeping moves it (no real waiting). */
let clock = Date.now();
const slept: number[] = [];
function deps(extra: Partial<RefreshDeps> = {}): RefreshDeps {
  return {
    db: ctx.db,
    queue: ctx.queue,
    network: shop.network,
    now: () => new Date(clock),
    sleep: (ms) => {
      slept.push(ms);
      clock += ms;
      return Promise.resolve();
    },
    ...extra,
  };
}

/** What a test shop page says; tests change it between runs. */
interface PageState {
  name: string;
  price: string | null;
  stock: 'InStock' | 'OutOfStock' | null;
  gtin?: string;
  /** Instead of the page: an HTTP status (404, 403, 429…), with optional headers. */
  status?: number;
  headers?: Record<string, string>;
  /** Never answers (a shop that hangs). */
  hang?: boolean;
}

function productHtml(path: string, state: PageState): string {
  const offer = [
    state.price === null ? '' : `"price":"${state.price}","priceCurrency":"SEK"`,
    state.stock === null ? '' : `"availability":"https://schema.org/${state.stock}"`,
  ]
    .filter(Boolean)
    .join(',');
  return `<!doctype html><html><head><link rel="canonical" href="${path}">
<script type="application/ld+json">{"@type":"Product","name":"${state.name}","brand":"Filippa K",
${state.gtin ? `"gtin13":"${state.gtin}",` : ''}"offers":{${offer}}}</script></head><body></body></html>`;
}

/** A product page at `path` (on `host`) whose answer follows `state` as it changes. */
function shopPage(path: string, state: PageState): PageState {
  shop.route(path, (request, response) => {
    if (state.hang) return; // never answers
    if (state.status) {
      response.writeHead(state.status, state.headers ?? {}).end();
      return;
    }
    page(productHtml(path, state))(request, response);
  });
  return state;
}

/** A link (as posted, with affiliate tags) read like a paste, on a shown look as a verified piece. */
async function linkOnLook(
  url: string,
  options: { lookId?: string; status?: 'verified' | 'pending' } = {},
) {
  const read = await readShopLink(new URL(url), { network: shop.network });
  const saved = await saveLinkRead(ctx.db, read);
  const lookId = options.lookId ?? (await createLook(ctx.db, { authorId: author }));
  const [item] = await ctx.db
    .insert(lookItems)
    .values({ lookId, offerId: saved.offerId, status: options.status ?? 'verified' })
    .returning({ id: lookItems.id });
  return { offerId: saved.offerId, productId: saved.productId, lookId, itemId: item?.id ?? '' };
}

/** Makes offers look last read `hours` ago, never checked by a run: due again. */
async function age(offerIds: string[], hours: number) {
  await ctx.db
    .update(offers)
    .set({
      lastCheckedAt: new Date(clock - hours * 60 * 60 * 1000),
      refreshTriedAt: null,
      refreshDueAt: null,
    })
    .where(inArray(offers.id, offerIds));
}

async function offer(id: string) {
  const [row] = await ctx.db.select().from(offers).where(eq(offers.id, id));
  if (!row) throw new Error('no offer');
  return row;
}

async function setSettings(patch: Partial<PriceRefreshSettings>) {
  await ctx.db
    .update(settings)
    .set({ value: { ...defaults, ...patch } })
    .where(eq(settings.key, PRICE_REFRESH_SETTING));
  forgetCachedSettings();
}

/** Requests the local shop got for a path (any query). */
function requestsFor(path: string) {
  return shop.requests.filter((r) => r.path.split('?')[0] === path);
}

beforeAll(async () => {
  ctx = await createTestContext();
  shop = await startLocalShop();
  author = await createAuthor(ctx.db, 'refresh.author');
  defaults = await priceRefreshSettings(ctx.db);
});

afterAll(async () => {
  await shop.close();
  await ctx.close();
});

beforeEach(async () => {
  clock = Date.now();
  slept.length = 0;
  ctx.queued.length = 0;
  await setSettings({});
  await ctx.db.delete(priceRefreshRuns);
  await ctx.db.delete(priceRefreshSites);
  // Links from earlier tests aren't due: each test ages its own.
  await ctx.db.update(offers).set({ refreshDueAt: sql`now() + interval '1 year'` });
});

describe('the settings row', () => {
  it('is inserted by the migration with sane caps', () => {
    expect(defaults).toEqual({
      savedOrPopularPerDay: 1000,
      othersPerDay: 500,
      popularLooks: 200,
      maxPerRun: 30,
      siteGapMs: 2000,
      goneAfter: 3,
    });
  });
});

describe('a run', () => {
  it('greys a piece whose shop page now says sold out (Done when)', async () => {
    const state = shopPage('/p/demo-coat', { name: 'Demo coat', price: '1299', stock: 'InStock' });
    const { offerId, lookId } = await linkOnLook(shop.url('/p/demo-coat?aff=poster'));
    const before = await lookDetail({ db: ctx.db, storage: ctx.storage }, null, lookId);
    expect(before.items).toHaveLength(1);
    expect(before.items[0]?.stock).toBe('in_stock');
    expect(piecesTotal(before.items).totals).toEqual([{ amountMinor: 129900, currency: 'SEK' }]);

    state.stock = 'OutOfStock';
    await age([offerId], 21);
    shop.requests.length = 0;
    const summary = await runPriceRefresh(deps());
    expect(summary.found).toMatchObject({ ok: 1, soldOut: 1 });

    const after = await lookDetail({ db: ctx.db, storage: ctx.storage }, null, lookId);
    expect(after.items).toHaveLength(1); // still shown, greyed: not rejected
    expect(after.items[0]?.stock).toBe('out_of_stock');
    expect(piecesTotal(after.items)).toMatchObject({ totals: [], soldOut: 1 });
    const [item] = await ctx.db.select().from(lookItems).where(eq(lookItems.offerId, offerId));
    expect(item?.status).toBe('verified');
    // The shop page was read, never the poster's affiliate link.
    expect(shop.requests.map((r) => r.path)).toEqual(['/p/demo-coat']);
    // And it's normal again once the shop has it back.
    state.stock = 'InStock';
    await age([offerId], 21);
    expect((await runPriceRefresh(deps())).found).toMatchObject({ ok: 1, backInStock: 1 });
    expect((await offer(offerId)).stock).toBe('in_stock');
  });

  it('adds one history entry when the price changes, none when it stays', async () => {
    const state = shopPage('/p/price', { name: 'Price coat', price: '1000', stock: 'InStock' });
    const { offerId } = await linkOnLook(shop.url('/p/price'));
    const history = async () =>
      ((await offer(offerId)).priceHistory as { priceMinor: number }[]).map((h) => h.priceMinor);
    expect(await history()).toEqual([100000]);

    await age([offerId], 21);
    expect((await runPriceRefresh(deps())).found).toMatchObject({ ok: 1, priceChanged: 0 });
    expect(await history()).toEqual([100000]);

    state.price = '800';
    await age([offerId], 21);
    expect((await runPriceRefresh(deps())).found).toMatchObject({ ok: 1, priceChanged: 1 });
    expect(await history()).toEqual([100000, 80000]);
    const row = await offer(offerId);
    expect(row).toMatchObject({ priceMinor: 80000, refreshOutcome: 'ok', refreshFailures: 0 });
    expect(row.lastCheckedAt?.getTime()).toBe(clock);
  });

  it('reads a page once and saves every link to it', async () => {
    shopPage('/p/shared', { name: 'Shared coat', price: '500', stock: 'InStock' });
    const first = await linkOnLook(shop.url('/p/shared?aff=anna'));
    const second = await linkOnLook(shop.url('/p/shared?aff=bo'));
    expect(second.productId).toBe(first.productId);
    await age([first.offerId, second.offerId], 21);
    shop.requests.length = 0;
    const summary = await runPriceRefresh(deps());
    expect(summary.reads.savedOrPopular).toBe(1);
    expect(requestsFor('/p/shared')).toHaveLength(1);
    for (const id of [first.offerId, second.offerId]) {
      const row = await offer(id);
      expect(row.lastCheckedAt?.getTime()).toBe(clock);
      expect(row.url).toContain('aff='); // the posted links stay as they were
    }
  });

  it('does nothing more when run again straight away', async () => {
    shopPage('/p/again', { name: 'Again coat', price: '500', stock: 'InStock' });
    const { offerId } = await linkOnLook(shop.url('/p/again'));
    await age([offerId], 21);
    expect((await runPriceRefresh(deps())).reads.savedOrPopular).toBe(1);
    const again = await runPriceRefresh(deps());
    expect(again.reads).toEqual({ savedOrPopular: 0, others: 0 });
    expect(await ctx.db.select().from(priceRefreshRuns)).toHaveLength(2);
  });

  it('leaves a verified piece verified when it sells out; a waiting one is rejected by its check', async () => {
    const state = shopPage('/p/both', { name: 'Both coat', price: '500', stock: 'InStock' });
    const shown = await linkOnLook(shop.url('/p/both?aff=shown'));
    // The same link on another look, still waiting for its check (Step 3.5).
    const otherLook = await createLook(ctx.db, { authorId: author });
    const [waiting] = await ctx.db
      .insert(lookItems)
      .values({ lookId: otherLook, offerId: shown.offerId, status: 'pending' })
      .returning({ id: lookItems.id });
    state.stock = 'OutOfStock';
    await age([shown.offerId], 21);
    expect((await runPriceRefresh(deps())).found.soldOut).toBe(1);
    const status = async (id: string) =>
      (await ctx.db.select().from(lookItems).where(eq(lookItems.id, id)))[0]?.status;
    expect(await status(shown.itemId)).toBe('verified');
    expect(await status(waiting?.id ?? '')).toBe('pending');
    const checked = await checkLookItem(
      { db: ctx.db, storage: ctx.storage, gemini: null, dailyCapMicros: 0 },
      waiting?.id ?? '',
    );
    expect(checked).toMatchObject({ outcome: 'rejected', reason: 'sold_out' });
    expect(await status(waiting?.id ?? '')).toBe('rejected');
  });

  it('asks no AI, and checks no look again unless the link moved', async () => {
    shopPage('/p/no-ai', { name: 'No AI coat', price: '500', stock: 'OutOfStock' });
    const { offerId } = await linkOnLook(shop.url('/p/no-ai'));
    const calls = (await ctx.db.select().from(aiCalls)).length;
    await age([offerId], 21);
    await runPriceRefresh(deps());
    expect((await ctx.db.select().from(aiCalls)).length).toBe(calls);
    expect(ctx.queued.filter((j) => j.name === LINK_CHECK_QUEUES.linkCheck)).toEqual([]);
  });
});

describe('what a page can answer', () => {
  it('never reads a shop that turns us away as sold out, and lets it rest', async () => {
    const state = shopPage('/p/walled', { name: 'Walled coat', price: '700', stock: 'InStock' });
    shopPage('/p/walled-2', { name: 'Walled coat 2', price: '700', stock: 'InStock' });
    const one = await linkOnLook(shop.url('/p/walled', 'wall.test'));
    const two = await linkOnLook(shop.url('/p/walled-2', 'wall.test'));
    state.status = 403;
    await age([one.offerId, two.offerId], 21);
    const read = await offer(one.offerId);
    shop.requests.length = 0;

    const summary = await runPriceRefresh(deps());
    expect(summary.found).toMatchObject({ blocked: 1, soldOut: 0, ok: 0 });
    // The shop rests: its other page isn't read in this run.
    expect(shop.requests).toHaveLength(1);
    const after = await offer(one.offerId);
    expect(after).toMatchObject({
      stock: 'in_stock',
      priceMinor: read.priceMinor,
      refreshOutcome: 'blocked',
      refreshFailures: 1,
    });
    expect(after.lastCheckedAt).toEqual(read.lastCheckedAt); // "price checked" doesn't move
    const [site] = await ctx.db.select().from(priceRefreshSites);
    expect(site).toMatchObject({ site: 'wall.test', lastProblem: 'blocked', strikes: 1 });
    expect(site?.restUntil.getTime()).toBe(clock + 6 * 60 * 60 * 1000);

    // Next run: still resting, nothing read there.
    shop.requests.length = 0;
    const next = await runPriceRefresh(deps());
    expect(next.restingSites).toEqual(['wall.test']);
    expect(shop.requests).toHaveLength(0);
  });

  it('waits as long as a busy shop asks (Retry-After)', async () => {
    const state = shopPage('/p/busy', { name: 'Busy coat', price: '700', stock: 'InStock' });
    const { offerId } = await linkOnLook(shop.url('/p/busy', 'busy.test'));
    state.status = 429;
    state.headers = { 'retry-after': '7200' };
    await age([offerId], 21);
    expect((await runPriceRefresh(deps())).found).toMatchObject({ blocked: 1, soldOut: 0 });
    const [site] = await ctx.db.select().from(priceRefreshSites);
    expect(site?.restUntil.getTime()).toBe(clock + 2 * 60 * 60 * 1000);
    expect((await offer(offerId)).stock).toBe('in_stock');
  });

  it("treats a shop that doesn't answer as couldn't check", async () => {
    const state = shopPage('/p/slow', { name: 'Slow coat', price: '700', stock: 'InStock' });
    const { offerId } = await linkOnLook(shop.url('/p/slow', 'slow.test'));
    state.hang = true;
    await age([offerId], 21);
    const summary = await runPriceRefresh(deps());
    expect(summary.found).toMatchObject({ failed: 1, soldOut: 0 });
    expect(await offer(offerId)).toMatchObject({
      stock: 'in_stock',
      refreshOutcome: 'failed',
      refreshFailures: 1,
    });
    const row = await offer(offerId);
    expect(row.refreshDueAt?.getTime()).toBe(clock + 6 * 60 * 60 * 1000);
  }, 20_000);

  it('counts a page as sold out after it was gone three checks in a row', async () => {
    const state = shopPage('/p/gone', { name: 'Gone coat', price: '700', stock: 'InStock' });
    const { offerId } = await linkOnLook(shop.url('/p/gone'));
    state.status = 404;
    for (const expected of [
      { gone: 1, stock: 'in_stock' },
      { gone: 2, stock: 'in_stock' },
      { gone: 3, stock: 'out_of_stock' },
    ]) {
      await age([offerId], 21);
      const summary = await runPriceRefresh(deps());
      expect(summary.found.gone).toBe(1);
      expect(summary.found.soldOut).toBe(expected.stock === 'out_of_stock' ? 1 : 0);
      expect(await offer(offerId)).toMatchObject({
        refreshGone: expected.gone,
        refreshOutcome: 'gone',
        stock: expected.stock,
      });
    }
    // The page comes back: in stock again, the count starts over.
    state.status = undefined;
    await age([offerId], 21);
    expect((await runPriceRefresh(deps())).found).toMatchObject({ ok: 1, backInStock: 1 });
    expect(await offer(offerId)).toMatchObject({ refreshGone: 0, stock: 'in_stock' });
  });

  it('counts a redirect to a page without a product as gone, the same page without one as unreadable', async () => {
    const state = { name: 'Moving coat', price: '700', stock: 'InStock' as const };
    shop.route('/p/retired', page(productHtml('/p/retired', state)));
    shop.route('/p/blank', page(productHtml('/p/blank', state)));
    shop.route('/women/coats', page('<html><head><title>Coats</title></head></html>'));
    const retired = await linkOnLook(shop.url('/p/retired'));
    const blank = await linkOnLook(shop.url('/p/blank'));
    shop.route('/p/retired', redirect(shop.url('/women/coats')));
    shop.route('/p/blank', page('<html><head><title>Coat</title></head></html>'));
    await age([retired.offerId, blank.offerId], 21);
    const summary = await runPriceRefresh(deps());
    expect(summary.found).toMatchObject({ gone: 1, unreadable: 1, soldOut: 0 });
    expect(await offer(retired.offerId)).toMatchObject({ refreshOutcome: 'gone', refreshGone: 1 });
    expect(await offer(blank.offerId)).toMatchObject({
      refreshOutcome: 'unreadable',
      refreshGone: 0,
      stock: 'in_stock',
    });
  });

  it('moves a link whose page now shows another item, leaving the shared product alone', async () => {
    const coat = { name: 'Real coat', price: '900', stock: 'InStock' as const };
    shop.route('/p/real-coat', page(productHtml('/p/real-coat', coat)));
    shop.route('/p/other-dress', page(productHtml('/p/other-dress', { ...coat, name: 'Dress' })));
    const { offerId, productId, itemId } = await linkOnLook(shop.url('/p/real-coat'));
    shop.route('/p/real-coat', redirect(shop.url('/p/other-dress')));
    await age([offerId], 21);
    expect((await runPriceRefresh(deps())).found).toMatchObject({ moved: 1 });
    const row = await offer(offerId);
    expect(row.productId).not.toBe(productId);
    expect(row.refreshOutcome).toBe('moved');
    const [kept] = await ctx.db.select().from(products).where(eq(products.id, productId));
    expect(kept?.name).toBe('Real coat');
    // Its look checks the link again (the only way a refresh leads to an AI call).
    const [item] = await ctx.db.select().from(lookItems).where(eq(lookItems.id, itemId));
    expect(item?.status).toBe('pending');
    expect(ctx.queued).toContainEqual({
      name: LINK_CHECK_QUEUES.linkCheck,
      data: { lookItemId: itemId },
    });
  });

  it('keeps the product when the shop moved the page and the barcode is the same', async () => {
    const coat = { name: 'Barcode coat', price: '900', stock: 'InStock' as const };
    const gtin = '7350000000061';
    shop.route('/p/old-slug', page(productHtml('/p/old-slug', { ...coat, gtin })));
    shop.route('/p/new-slug', page(productHtml('/p/new-slug', { ...coat, gtin })));
    const { offerId, productId, itemId } = await linkOnLook(shop.url('/p/old-slug'));
    shop.route('/p/old-slug', redirect(shop.url('/p/new-slug'), 301));
    await age([offerId], 21);
    expect((await runPriceRefresh(deps())).found).toMatchObject({ ok: 1, moved: 0 });
    const row = await offer(offerId);
    expect(row).toMatchObject({ productId, pageUrl: shop.url('/p/new-slug') });
    const [item] = await ctx.db.select().from(lookItems).where(eq(lookItems.id, itemId));
    expect(item?.status).toBe('verified');
  });
});

describe('which pages a run reads', () => {
  it('reads links on saved looks daily and the rest weekly', async () => {
    await setSettings({ popularLooks: 0 });
    shopPage('/p/saved', { name: 'Saved coat', price: '500', stock: 'InStock' });
    shopPage('/p/plain', { name: 'Plain coat', price: '500', stock: 'InStock' });
    const saved = await linkOnLook(shop.url('/p/saved'));
    const plain = await linkOnLook(shop.url('/p/plain'));
    await ctx.db.insert(saves).values({ profileId: author, lookId: saved.lookId });

    await age([saved.offerId, plain.offerId], 21);
    expect((await runPriceRefresh(deps())).reads).toEqual({ savedOrPopular: 1, others: 0 });
    expect((await offer(plain.offerId)).refreshTriedAt).toBeNull();

    await age([plain.offerId], 8 * 24);
    expect((await runPriceRefresh(deps())).reads).toEqual({ savedOrPopular: 0, others: 1 });
  });

  it('counts a board as saved, and puts the most saved first', async () => {
    await setSettings({ popularLooks: 0 });
    shopPage('/p/board', { name: 'Board coat', price: '500', stock: 'InStock' });
    shopPage('/p/two-saves', { name: 'Two saves coat', price: '500', stock: 'InStock' });
    const onBoard = await linkOnLook(shop.url('/p/board'));
    const twice = await linkOnLook(shop.url('/p/two-saves'));
    const [board] = await ctx.db
      .insert(boards)
      .values({ profileId: author, name: 'Coats' })
      .returning({ id: boards.id });
    await ctx.db.insert(boardItems).values({ boardId: board?.id ?? '', lookId: onBoard.lookId });
    const other = await createAuthor(ctx.db, 'refresh.saver');
    await ctx.db.insert(saves).values([
      { profileId: author, lookId: twice.lookId },
      { profileId: other, lookId: twice.lookId },
    ]);
    await age([onBoard.offerId, twice.offerId], 21);
    const due = await duePages(ctx.db, await priceRefreshSettings(ctx.db), new Date(clock), 10);
    expect(due.map((d) => [d.pageUrl, d.important, d.savers])).toEqual([
      [shop.url('/p/two-saves'), true, 2],
      [shop.url('/p/board'), true, 1],
    ]);
  });

  it("leaves links alone that aren't on a shown look", async () => {
    shopPage('/p/unshown', { name: 'Unshown coat', price: '500', stock: 'InStock' });
    const pending = await linkOnLook(shop.url('/p/unshown?aff=pending'), { status: 'pending' });
    const hidden = await linkOnLook(shop.url('/p/unshown?aff=hidden'));
    await ctx.db.update(looks).set({ status: 'hidden' }).where(eq(looks.id, hidden.lookId));
    await age([pending.offerId, hidden.offerId], 30 * 24);
    expect((await runPriceRefresh(deps())).reads).toEqual({ savedOrPopular: 0, others: 0 });
  });

  it('keeps to the daily cap and spreads it over the runs left today', async () => {
    shopPage('/p/cap-1', { name: 'Cap coat 1', price: '500', stock: 'InStock' });
    shopPage('/p/cap-2', { name: 'Cap coat 2', price: '500', stock: 'InStock' });
    const one = await linkOnLook(shop.url('/p/cap-1'));
    const two = await linkOnLook(shop.url('/p/cap-2'));
    await setSettings({ savedOrPopularPerDay: 1 });
    await age([one.offerId, two.offerId], 21);
    expect((await runPriceRefresh(deps())).reads.savedOrPopular).toBe(1);
    expect((await runPriceRefresh(deps())).reads.savedOrPopular).toBe(0); // cap used up today

    // 144 runs a day: 1,000 a day is 7 a run at midnight, all that's left near the end.
    expect(runShare(1000, new Date('2026-11-06T00:00:00Z'), 30)).toBe(7);
    expect(runShare(1000, new Date('2026-11-06T23:55:00Z'), 30)).toBe(30);
    expect(runShare(0, new Date('2026-11-06T12:00:00Z'), 30)).toBe(0);
  });

  it('reads one shop at most every siteGapMs, other shops in between', async () => {
    for (const path of ['/p/gap-a1', '/p/gap-a2', '/p/gap-b1']) {
      shopPage(path, { name: `Gap ${path}`, price: '500', stock: 'InStock' });
    }
    // gap-a.test and www.gap-a.test are one shop.
    const a1 = await linkOnLook(shop.url('/p/gap-a1', 'gap-a.test'));
    const a2 = await linkOnLook(shop.url('/p/gap-a2', 'www.gap-a.test'));
    const b1 = await linkOnLook(shop.url('/p/gap-b1', 'gap-b.test'));
    await age([a1.offerId, a2.offerId, b1.offerId], 21);
    shop.requests.length = 0;
    const run = await runPriceRefresh(deps());
    expect(run.reads.savedOrPopular).toBe(3);
    // The other shop went in between, then the run waited out the gap for the second page.
    expect(shop.requests.map((r) => r.host.split(':')[0])).toEqual([
      'gap-a.test',
      'gap-b.test',
      'www.gap-a.test',
    ]);
    expect(slept).toEqual([defaults.siteGapMs]);
  });
});

describe('waiting rules', () => {
  it('backs off after failures and rests shops longer each time', () => {
    expect(failureBackoff('failed', 1)).toBe(6 * 60 * 60 * 1000);
    expect(failureBackoff('failed', 2)).toBe(12 * 60 * 60 * 1000);
    expect(failureBackoff('unreadable', 1)).toBe(20 * 60 * 60 * 1000);
    expect(failureBackoff('blocked', 20)).toBe(7 * 24 * 60 * 60 * 1000);
    const walled = new LinkFetchError('blocked', 'no', 403);
    expect(siteRest(walled, 1)).toBe(6 * 60 * 60 * 1000);
    expect(siteRest(walled, 2)).toBe(12 * 60 * 60 * 1000);
    const busy = new LinkFetchError('blocked', 'busy', 503, 3 * 60 * 60 * 1000);
    expect(siteRest(busy, 1)).toBe(3 * 60 * 60 * 1000);
    expect(siteRest(new LinkFetchError('blocked', 'busy', 429), 1)).toBe(30 * 60 * 1000);
    expect(siteRest(new LinkFetchError('too_slow', 'slow'), 1)).toBe(60 * 60 * 1000);
  });

  it('reads Retry-After as seconds or a date', () => {
    const now = Date.parse('2026-11-06T12:00:00Z');
    expect(retryAfterMs('120', now)).toBe(120_000);
    expect(retryAfterMs('Fri, 06 Nov 2026 13:00:00 GMT', now)).toBe(60 * 60 * 1000);
    expect(retryAfterMs('soon', now)).toBeNull();
    expect(retryAfterMs(null, now)).toBeNull();
  });
});

describe('the live demo (pnpm refresh:demo)', () => {
  it('puts a verified piece from our own page on a look, greys it, and removes it again', async () => {
    const base = shop.url('', 'media.test');
    const pageUrl = `${base}/${DEMO_PREFIX}coat.html`;
    let stock: 'InStock' | 'OutOfStock' = 'InStock';
    shop.route(`/${DEMO_PREFIX}coat.html`, (request, response) => {
      page(demoPageHtml(pageUrl, stock))(request, response);
    });
    const lookId = await createLook(ctx.db, { authorId: author });
    const { offerId } = await attachDemoPiece(ctx.db, lookId, pageUrl, shop.network);
    expect(await offer(offerId)).toMatchObject({
      url: `${pageUrl}?aff=demo`,
      pageUrl,
      priceMinor: 149900,
      currency: 'SEK',
      stock: 'in_stock',
    });
    const shown = await lookDetail({ db: ctx.db, storage: ctx.storage }, null, lookId);
    expect(shown.items.map((i) => [i.name, i.stock])).toEqual([['Refresh demo coat', 'in_stock']]);

    stock = 'OutOfStock';
    expect((await runPriceRefresh(deps(), { pageUrl })).found).toMatchObject({ soldOut: 1 });
    const greyed = await lookDetail({ db: ctx.db, storage: ctx.storage }, null, lookId);
    expect(greyed.items[0]?.stock).toBe('out_of_stock');

    expect(await removeDemoPieces(ctx.db, base)).toBe(1);
    expect(await ctx.db.select().from(offers).where(eq(offers.id, offerId))).toEqual([]);
    const left = await lookDetail({ db: ctx.db, storage: ctx.storage }, null, lookId);
    expect(left.items).toEqual([]);
  });
});
