import { eq, featureFlags, offers, products, sql } from '@outfitly/db';
import { IDEMPOTENT_REPLAY_HEADER, type ResolvedLink, resolvedLinkSchema } from '@outfitly/shared';
import type { FastifyInstance } from 'fastify';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { buildApp } from '../src/app.ts';
import { PRODUCT_QUEUES } from '../src/links/product-photos.ts';
import { createLogin } from './feed-fixtures.ts';
import { createTestContext, type TestContext, testConfig, testJwks } from './helpers.ts';
import { type LocalShop, page, redirect, startLocalShop } from './local-shop.ts';
import { articlePage, jsonLdProductPage, metaOnlyPage } from './shop-pages.ts';

let ctx: TestContext;
let app: FastifyInstance;
let shop: LocalShop;
let token: string;

function resolve(url: string, key: string = crypto.randomUUID(), as = token) {
  return app.inject({
    method: 'POST',
    url: '/v1/links/resolve',
    headers: { authorization: `Bearer ${as}`, 'idempotency-key': key },
    payload: { url },
  });
}

async function resolved(url: string): Promise<ResolvedLink> {
  const res = await resolve(url);
  expect(res.statusCode, res.body).toBe(200);
  return resolvedLinkSchema.parse(res.json());
}

/** Makes an offer look like it was read two hours ago, so the next resolve reads the shop again. */
async function age(offerId: string) {
  await ctx.db
    .update(offers)
    .set({ lastCheckedAt: sql`now() - interval '2 hours'` })
    .where(eq(offers.id, offerId));
}

/** A new login with its personal profile (each login has its own link limit per minute). */
async function freshLogin(): Promise<string> {
  const login = await createLogin(ctx.db);
  const session = await app.inject({
    method: 'POST',
    url: '/v1/session',
    headers: { authorization: `Bearer ${login.token}`, 'idempotency-key': crypto.randomUUID() },
    payload: {},
  });
  expect(session.statusCode).toBe(200);
  return login.token;
}

let coatPrice = '3 499,00';

beforeAll(async () => {
  ctx = await createTestContext();
  shop = await startLocalShop();
  app = await buildApp({
    config: testConfig(ctx.testDb.url),
    db: ctx.db,
    jwks: testJwks,
    storage: ctx.storage,
    queue: ctx.queue,
    logger: false,
    linkNetwork: shop.network,
  });
  await app.ready();
  token = await freshLogin();

  shop.route('/p/wool-coat', (request, response) => {
    page(jsonLdProductPage({ canonical: '/p/wool-coat', price: coatPrice }))(request, response);
  });
  // An affiliate network's link: redirects to the shop with its own tracking tags.
  shop.route(
    '/t',
    redirect(shop.url('/p/wool-coat?utm_source=adtraction&at_gd=abc', 'www.shop.test')),
  );
  shop.route('/dress', page(metaOnlyPage.replace('https://nelly.example/se/dress-123/', '/dress')));
  shop.route('/blog', page(articlePage));
  // Another shop selling the same coat (same barcode), under its own name.
  shop.route(
    '/other-coat',
    page(jsonLdProductPage({ price: '3 299,00' }).replace('Wool-blend coat &amp; belt', 'Coat FK')),
  );
});

beforeEach(() => {
  ctx.queued.length = 0;
});

afterAll(async () => {
  await app.close();
  await shop.close();
  await ctx.close();
});

describe('POST /v1/links/resolve', () => {
  it('needs a login', async () => {
    const res = await app.inject({
      method: 'POST',
      url: '/v1/links/resolve',
      payload: { url: shop.url('/p/wool-coat') },
    });
    expect(res.statusCode).toBe(401);
  });

  it('creates the product and offer, keeping the posted link exactly', async () => {
    const posted = `${shop.url('/t')}?aff=elias&utm_campaign=spring`;
    const answer = await resolved(`Love this coat ${posted}`);
    expect(answer.outcome).toBe('created');
    expect(answer.offer.url).toBe(posted);
    // The shop's own page: canonical link, tracking gone.
    expect(answer.offer.pageUrl).toBe(shop.url('/p/wool-coat', 'www.shop.test'));
    expect(answer.offer).toMatchObject({ priceMinor: 349900, currency: 'SEK', stock: 'in_stock' });
    expect(answer.product).toMatchObject({
      name: 'Wool-blend coat & belt',
      brand: 'Filippa K',
      gtin: '07350000000009',
      imageUrl: 'https://cdn.shop.example/coat-1.jpg',
      image: null,
    });
    expect(ctx.queued).toEqual([
      { name: PRODUCT_QUEUES.productPhoto, data: { productId: answer.product.id } },
    ]);
    const [row] = await ctx.db.select().from(offers).where(eq(offers.id, answer.offer.id));
    expect(row?.priceHistory).toEqual([
      { at: expect.any(String) as string, priceMinor: 349900, currency: 'SEK' },
    ]);
  });

  it('answers a link read within the hour from the database', async () => {
    const first = await resolved(shop.url('/p/wool-coat?aff=recent'));
    const asked = shop.requests.length;
    const again = await resolved(shop.url('/p/wool-coat?aff=recent'));
    expect(again.outcome).toBe('recent');
    expect(again.offer.id).toBe(first.offer.id);
    expect(shop.requests.length).toBe(asked);
  });

  it('updates the offer when read again, keeping price history', async () => {
    const link = shop.url('/p/wool-coat?aff=history');
    const first = await resolved(link);
    await age(first.offer.id);
    coatPrice = '2 999,00';
    try {
      const second = await resolved(link);
      expect(second.outcome).toBe('updated');
      expect(second.offer.id).toBe(first.offer.id);
      expect(second.offer.priceMinor).toBe(299900);
      const [row] = await ctx.db.select().from(offers).where(eq(offers.id, first.offer.id));
      expect((row?.priceHistory as { priceMinor: number }[]).map((h) => h.priceMinor)).toEqual([
        349900, 299900,
      ]);
      // The same price again adds nothing.
      await age(first.offer.id);
      await resolved(link);
      const [after] = await ctx.db.select().from(offers).where(eq(offers.id, first.offer.id));
      expect(after?.priceHistory).toHaveLength(2);
    } finally {
      coatPrice = '3 499,00';
    }
  });

  it('gives another poster’s link to the same page its own offer on the same product', async () => {
    const mine = await resolved(shop.url('/p/wool-coat?aff=one'));
    const theirs = await resolved(shop.url('/p/wool-coat?aff=two'));
    expect(theirs.outcome).toBe('created');
    expect(theirs.offer.id).not.toBe(mine.offer.id);
    expect(theirs.product.id).toBe(mine.product.id);
  });

  it('matches another shop’s page by barcode and keeps the first name', async () => {
    const coat = await resolved(shop.url('/p/wool-coat?aff=barcode'));
    const elsewhere = await resolved(shop.url('/other-coat', 'othershop.test'));
    expect(elsewhere.product.id).toBe(coat.product.id);
    expect(elsewhere.product.name).toBe('Wool-blend coat & belt');
    expect(elsewhere.offer.priceMinor).toBe(329900);
    const coats = await ctx.db.select().from(products).where(eq(products.gtin, '07350000000009'));
    expect(coats).toHaveLength(1);
  });

  it('reads Open Graph-only pages', async () => {
    const dress = await resolved(shop.url('/dress'));
    expect(dress.product).toMatchObject({ name: 'Satin slip dress', brand: 'Nelly', gtin: null });
    expect(dress.offer).toMatchObject({
      priceMinor: 129900,
      currency: 'SEK',
      stock: 'out_of_stock',
    });
  });

  it('replays a retried request instead of reading twice', async () => {
    const key = crypto.randomUUID();
    const link = shop.url('/dress?aff=retry');
    const first = await resolve(link, key);
    const second = await resolve(link, key);
    expect(second.statusCode).toBe(200);
    expect(second.headers[IDEMPOTENT_REPLAY_HEADER]).toBe('true');
    expect(second.json()).toEqual(first.json());
    const rows = await ctx.db.select().from(offers).where(eq(offers.url, link));
    expect(rows).toHaveLength(1);
  });

  it('brings a removed offer back when its link is posted again', async () => {
    const link = shop.url('/dress?aff=removed');
    const first = await resolved(link);
    await ctx.db
      .update(offers)
      .set({ deletedAt: sql`now()`, lastCheckedAt: sql`now() - interval '2 hours'` })
      .where(eq(offers.id, first.offer.id));
    const again = await resolved(link);
    expect(again.offer.id).toBe(first.offer.id);
    const [row] = await ctx.db.select().from(offers).where(eq(offers.id, first.offer.id));
    expect(row?.deletedAt).toBeNull();
  });

  it('explains links that give no product', async () => {
    const cases: [string, string][] = [
      [shop.url('/blog'), 'no_product'],
      ['not a link at all', 'bad_link'],
      ['http://10.0.0.7/p/1', 'forbidden'],
      [shop.url('/missing'), 'not_found'],
      [`https://shop.test/${'x'.repeat(2100)}`, 'bad_link'],
    ];
    const someone = await freshLogin();
    for (const [url, problem] of cases) {
      const res = await resolve(url, crypto.randomUUID(), someone);
      expect(res.statusCode, url.slice(0, 60)).toBe(422);
      expect(res.json()).toMatchObject({
        error: { code: 'link_unreadable', details: { problem } },
      });
    }
  });

  it('asks no page reader when its flag is off', async () => {
    const [flag] = await ctx.db
      .select()
      .from(featureFlags)
      .where(eq(featureFlags.key, 'link_reader_microlink'));
    expect(flag?.enabled ?? false).toBe(false);
    shop.lookups.length = 0;
    const res = await resolve(shop.url('/blog'), crypto.randomUUID(), await freshLogin());
    expect(res.json()).toMatchObject({ error: { details: { problem: 'no_product' } } });
    expect(shop.lookups).not.toContain('api.microlink.io');
  });

  it('limits each login to 20 links a minute', async () => {
    const someone = await freshLogin();
    for (let i = 0; i < 20; i++) {
      expect((await resolve('not a link', crypto.randomUUID(), someone)).statusCode).toBe(422);
    }
    const res = await resolve('not a link', crypto.randomUUID(), someone);
    expect(res.statusCode).toBe(429);
    expect(res.json()).toMatchObject({ error: { code: 'rate_limited' } });
    // Someone else isn't affected.
    expect((await resolve('not a link', crypto.randomUUID(), await freshLogin())).statusCode).toBe(
      422,
    );
  });
});
