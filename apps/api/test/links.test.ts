import { eq, featureFlags, offers, products, sql } from '@outfitly/db';
import { readShopLink } from '../src/links/resolve.ts';
import { readWithMicrolink } from '../src/links/microlink.ts';
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

beforeEach(async () => {
  ctx.queued.length = 0;
  // Each test as its own login: every login may resolve 20 links a minute.
  token = await freshLogin();
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
      image: null,
    });
    expect(answer.product).not.toHaveProperty('imageUrl'); // only our own copy is ever shown
    const [product] = await ctx.db
      .select()
      .from(products)
      .where(eq(products.id, answer.product.id));
    expect(product?.imageUrl).toBe('https://cdn.shop.example/coat-1.jpg');
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
    ctx.queued.length = 0;
    const again = await resolved(shop.url('/p/wool-coat?aff=recent'));
    expect(again.outcome).toBe('recent');
    // The photo still isn't copied (no job runner here): it's asked for again.
    expect(ctx.queued).toEqual([
      { name: PRODUCT_QUEUES.productPhoto, data: { productId: first.product.id } },
    ]);
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

/** A product page with JSON-LD, its own canonical link, and the given barcode and brand. */
function productPage(path: string, name: string, brand: string, gtin = ''): string {
  return `<link rel="canonical" href="${path}">
<script type="application/ld+json">{"@type":"Product","name":"${name}","brand":"${brand}",
${gtin ? `"gtin13":"${gtin}",` : ''}"offers":{"price":"100","priceCurrency":"SEK"}}</script>`;
}

async function product(id: string) {
  const [row] = await ctx.db.select().from(products).where(eq(products.id, id));
  return row;
}

describe('which product a link is', () => {
  it('moves a link that now lands on another page, leaving the shared product alone', async () => {
    let target = '/p/wool-coat';
    shop.route('/go', (request, response) => {
      redirect(shop.url(target))(request, response);
    });
    const link = shop.url('/go?aff=moving');
    const first = await resolved(link);
    const other = await resolved(shop.url('/p/wool-coat?aff=staying'));
    expect(other.product.id).toBe(first.product.id);

    await age(first.offer.id);
    target = '/dress';
    const moved = await resolved(link);
    expect(moved.offer.id).toBe(first.offer.id);
    expect(moved.product.id).not.toBe(first.product.id);
    expect(moved.product.name).toBe('Satin slip dress');
    expect((await product(first.product.id))?.name).toBe('Wool-blend coat & belt');
    // The link's price history starts again for the item it now shows.
    const [row] = await ctx.db.select().from(offers).where(eq(offers.id, first.offer.id));
    expect((row?.priceHistory as { priceMinor: number }[]).map((h) => h.priceMinor)).toEqual([
      129900,
    ]);
  });

  it('treats a page whose barcode changed as another product', async () => {
    let gtin = '7350000000030';
    shop.route('/p/changing', (request, response) => {
      page(productPage('/p/changing', `Coat ${gtin}`, 'Acne', gtin))(request, response);
    });
    const first = await resolved(shop.url('/p/changing'));
    expect(first.product.gtin).toBe('07350000000030');
    await age(first.offer.id);
    gtin = '7350000000047';
    const second = await resolved(shop.url('/p/changing'));
    expect(second.offer.id).toBe(first.offer.id);
    expect(second.product.id).not.toBe(first.product.id);
    expect(second.product.gtin).toBe('07350000000047');
    expect((await product(first.product.id))?.name).toBe('Coat 7350000000030');
  });

  it('keeps products apart when a barcode comes with another brand', async () => {
    const coat = await resolved(shop.url('/p/wool-coat?aff=brand'));
    shop.route(
      '/knockoff',
      page(productPage('/knockoff', 'Coat', 'Knockoff Ltd', '7350000000009')),
    );
    const knockoff = await resolved(shop.url('/knockoff', 'thirdshop.test'));
    expect(knockoff.product.id).not.toBe(coat.product.id);
    expect(knockoff.product.gtin).toBeNull(); // the barcode belongs to the real coat
    // Same barcode, no brand: not enough to merge either.
    shop.route('/nobrand', page(productPage('/nobrand', 'Coat', '', '7350000000009')));
    const noBrand = await resolved(shop.url('/nobrand', 'thirdshop.test'));
    expect(noBrand.product.id).not.toBe(coat.product.id);
  });

  it('never merges two pages of one shop by barcode', async () => {
    const coat = await resolved(shop.url('/p/wool-coat?aff=site'));
    shop.route(
      '/p/wool-coat-2',
      page(productPage('/p/wool-coat-2', 'Other coat', 'Filippa K', '7350000000009')),
    );
    const other = await resolved(shop.url('/p/wool-coat-2'));
    expect(other.product.id).not.toBe(coat.product.id);
  });

  it('makes a new product instead of bringing back a removed one', async () => {
    shop.route(
      '/p/removed',
      page(productPage('/p/removed', 'Removed coat', 'Arket', '7350000000054')),
    );
    const first = await resolved(shop.url('/p/removed'));
    await ctx.db
      .update(products)
      .set({ deletedAt: sql`now()` })
      .where(eq(products.id, first.product.id));
    await age(first.offer.id);
    // Another link to the same page, and the same link again: neither revives it.
    const other = await resolved(shop.url('/p/removed?aff=other'));
    const again = await resolved(shop.url('/p/removed'));
    expect(other.product.id).not.toBe(first.product.id);
    expect(again.product.id).toBe(other.product.id);
    expect((await product(first.product.id))?.deletedAt).not.toBeNull();
  });

  it('saves one offer when the same new link is resolved five times at once', async () => {
    const link = shop.url('/dress?aff=race');
    const answers = await Promise.all(Array.from({ length: 5 }, () => resolve(link)));
    expect(answers.map((a) => a.statusCode)).toEqual([200, 200, 200, 200, 200]);
    const outcomes = answers.map((a) => resolvedLinkSchema.parse(a.json()).outcome);
    expect(outcomes.filter((o) => o === 'created')).toHaveLength(1);
    const rows = await ctx.db.select().from(offers).where(eq(offers.url, link));
    expect(rows).toHaveLength(1);
  });
});

describe('temporary problems and other readers', () => {
  it('reads again with the same key after a busy shop', async () => {
    let calls = 0;
    shop.route('/flaky', (request, response) => {
      calls += 1;
      if (calls === 1) response.writeHead(503).end();
      else page(productPage('/flaky', 'Flaky top', 'Weekday'))(request, response);
    });
    const key = crypto.randomUUID();
    const first = await resolve(shop.url('/flaky'), key);
    expect(first.statusCode).toBe(422);
    expect(first.json()).toMatchObject({
      error: { details: { problem: 'blocked', temporary: true, shopStatus: 503 } },
    });
    const second = await resolve(shop.url('/flaky'), key);
    expect(second.statusCode).toBe(200);
    expect(second.headers[IDEMPOTENT_REPLAY_HEADER]).toBeUndefined();
  });

  it('replays a lasting problem under the same key', async () => {
    const key = crypto.randomUUID();
    const first = await resolve(shop.url('/blog'), key);
    expect(first.json()).toMatchObject({
      error: { details: { problem: 'no_product', temporary: false } },
    });
    const second = await resolve(shop.url('/blog'), key);
    expect(second.headers[IDEMPOTENT_REPLAY_HEADER]).toBe('true');
  });

  it('asks the fallback reader only about pages without product data', async () => {
    const asked: string[] = [];
    const fallback = (pageUrl: string) => {
      asked.push(pageUrl);
      return Promise.resolve({
        name: 'Read elsewhere',
        brand: null,
        gtin: null,
        imageUrl: null,
        priceMinor: null,
        currency: null,
        stock: 'unknown' as const,
        source: 'microlink' as const,
      });
    };
    const read = await readShopLink(new URL(shop.url('/blog')), {
      network: shop.network,
      fallback,
    });
    expect(read.product.name).toBe('Read elsewhere');
    expect(asked).toEqual([shop.url('/blog')]);

    shop.route('/bot-wall', (_request, response) => response.writeHead(403).end());
    await expect(
      readShopLink(new URL(shop.url('/bot-wall')), { network: shop.network, fallback }),
    ).rejects.toMatchObject({ problem: 'blocked' });
    expect(asked).toHaveLength(1);
  });

  it('reads Microlink’s answer', async () => {
    shop.route('/microlink', (request, response) => {
      const asked = new URL(request.url ?? '/', 'http://x').searchParams.get('url');
      response.writeHead(200, { 'content-type': 'application/json' }).end(
        JSON.stringify({
          status: 'success',
          data: {
            title: ` Linen shirt  ${asked ?? ''}`,
            image: { url: 'https://cdn.example/s.jpg' },
          },
        }),
      );
    });
    shop.route('/microlink-broken', (_request, response) =>
      response.writeHead(200, { 'content-type': 'application/json' }).end('{not json'),
    );
    const product = await readWithMicrolink('https://shop.example/p/1', {
      network: shop.network,
      endpoint: shop.url('/microlink'),
    });
    expect(product).toMatchObject({
      name: 'Linen shirt https://shop.example/p/1',
      imageUrl: 'https://cdn.example/s.jpg',
      priceMinor: null,
      source: 'microlink',
    });
    expect(
      await readWithMicrolink('https://shop.example/p/1', {
        network: shop.network,
        endpoint: shop.url('/microlink-broken'),
      }),
    ).toBeNull();
  });
});
