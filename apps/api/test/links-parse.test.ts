import { describe, expect, it } from 'vitest';
import { isPublicAddress } from '../src/links/address.ts';
import {
  normalizeGtin,
  pageText,
  parsePrice,
  readProductPage,
  stockOf,
} from '../src/links/parse.ts';
import { linkFromInput, shopPageUrl } from '../src/links/urls.ts';
import {
  aggregateOfferPage,
  articlePage,
  jsonLdProductPage,
  metaOnlyPage,
  productGroupPage,
  salePricePage,
} from './shop-pages.ts';

const page = new URL('https://shop.example/p/wool-coat?colour=black');

describe('prices', () => {
  it.each([
    ['1 299,00', 'SEK', 129900],
    ['1.299,00', 'EUR', 129900],
    ['1,299.00', 'USD', 129900],
    ['1299', 'SEK', 129900],
    ['1299.5', 'SEK', 129950],
    ['12,5', 'EUR', 1250],
    ['1299.000', 'SEK', 129900],
    ['1.299.000', 'SEK', 129900000],
    ['12,345.67', 'USD', 1234567],
    ['1,299,000', 'SEK', 129900000],
    ['SEK 499', 'SEK', 49900],
    ['499 kr', 'SEK', 49900],
    ['€49.99', 'EUR', 4999],
    ['1 299,00 kr', 'SEK', 129900],
    ['0.005', 'EUR', 1],
    [1299.9, 'SEK', 129990],
    [19.99, 'EUR', 1999],
    ['4990', 'ISK', 4990],
    [4990, 'JPY', 4990],
  ])('%s %s → %d', (value, currency, minor) => {
    expect(parsePrice(value, currency)).toBe(minor);
  });

  it.each([
    ['free', 'SEK'],
    ['499', 'XYZ1'],
    ['499', 'sek'],
    [-5, 'SEK'],
    [Number.NaN, 'SEK'],
    ['99999999999', 'SEK'],
    [null, 'SEK'],
    // Thousands or decimals? No price rather than a wrong one.
    ['199.000', 'SEK'],
    ['1.299', 'EUR'],
    ['1,299', 'USD'],
    ['1,2.3', 'SEK'],
    ['1.2,30', 'SEK'],
    ['499', 'ABC'],
    // A price of 0 is a placeholder: no price.
    [0, 'EUR'],
    ['0', 'SEK'],
    ['0,00 kr', 'SEK'],
    ['0.004', 'EUR'],
  ])('%s %s → no price', (value, currency) => {
    expect(parsePrice(value, currency)).toBeNull();
  });
});

describe('barcodes and stock', () => {
  it('pads valid barcodes to 14 digits and refuses bad check digits', () => {
    expect(normalizeGtin('7350000000009')).toBe('07350000000009');
    expect(normalizeGtin(7350000000009)).toBe('07350000000009');
    expect(normalizeGtin('96385074')).toBe('00000096385074'); // GTIN-8
    expect(normalizeGtin('7350000000008')).toBeNull(); // wrong check digit
    expect(normalizeGtin('12345')).toBeNull();
    expect(normalizeGtin('SKU-7350000000009')).toBeNull();
    expect(normalizeGtin('00000000000000')).toBeNull();
  });

  it('maps schema.org and Open Graph availability', () => {
    expect(stockOf('https://schema.org/InStock')).toBe('in_stock');
    expect(stockOf('http://schema.org/LimitedAvailability')).toBe('in_stock');
    expect(stockOf('PreOrder')).toBe('in_stock');
    expect(stockOf('https://schema.org/OutOfStock')).toBe('out_of_stock');
    expect(stockOf('out of stock')).toBe('out_of_stock');
    expect(stockOf('SoldOut')).toBe('out_of_stock');
    expect(stockOf('InStoreOnly')).toBe('unknown');
    expect(stockOf(undefined)).toBe('unknown');
  });
});

describe('reading product pages', () => {
  it('reads the page’s own JSON-LD product, not a recommended one', () => {
    const read = readProductPage(
      jsonLdProductPage({ canonical: '/p/wool-coat' }),
      new URL('https://shop.example/p/wool-coat?utm_source=x'),
    );
    expect(read.product).toEqual({
      name: 'Wool-blend coat & belt',
      brand: 'Filippa K',
      gtin: '07350000000009',
      imageUrl: 'https://cdn.shop.example/coat-1.jpg',
      priceMinor: 349900,
      currency: 'SEK',
      stock: 'in_stock',
      source: 'json-ld',
    });
    expect(read.canonicalUrl).toBe('https://shop.example/p/wool-coat');
  });

  it('reads a ProductGroup in @graph: lowest in-stock size, no per-size barcode', () => {
    const read = readProductPage(productGroupPage, page);
    expect(read.product).toMatchObject({
      name: 'H&M Straight jeans',
      brand: 'H&M',
      gtin: null,
      imageUrl: 'https://image.hm.example/jeans.jpg',
      priceMinor: 24990,
      currency: 'SEK',
      stock: 'in_stock',
    });
  });

  it('reads sizes told apart by the query as the whole product on the bare page', () => {
    // Google's and Shopify's ProductGroup markup: XS sold out, M in stock.
    const group = `<script type="application/ld+json">
{"@context":"https://schema.org","@type":"ProductGroup","name":"Wool coat","brand":"Filippa K",
 "url":"https://shop.example/p/coat","variesBy":["https://schema.org/size"],"hasVariant":[
  {"@type":"Product","name":"Wool coat XS","url":"https://shop.example/p/coat?size=xs",
   "gtin":"7350000000016","offers":{"price":"1999","priceCurrency":"SEK",
   "availability":"https://schema.org/OutOfStock"}},
  {"@type":"Product","name":"Wool coat M","url":"https://shop.example/p/coat?size=m",
   "gtin":"7350000000023","offers":{"price":"1999","priceCurrency":"SEK",
   "availability":"https://schema.org/InStock"}}]}
</script>`;
    const bare = readProductPage(group, new URL('https://shop.example/p/coat'));
    expect(bare.product).toMatchObject({ gtin: null, stock: 'in_stock', priceMinor: 199900 });
    // A page for one size (tracking tags beside it don't matter) is that size.
    const medium = readProductPage(group, new URL('https://shop.example/p/coat?size=m&aff=1'));
    expect(medium.product).toMatchObject({ gtin: '07350000000023', stock: 'in_stock' });
    const small = readProductPage(group, new URL('https://shop.example/p/coat?size=xs'));
    expect(small.product).toMatchObject({ gtin: '07350000000016', stock: 'out_of_stock' });
    // Every size on the same address: none of them is "this page".
    const same = group.replaceAll('?size=xs', '').replaceAll('?size=m', '');
    const shared = readProductPage(same, new URL('https://shop.example/p/coat'));
    expect(shared.product).toMatchObject({ gtin: null, stock: 'in_stock' });
  });

  it('reads an AggregateOffer and survives broken JSON-LD blocks', () => {
    const read = readProductPage(aggregateOfferPage, page);
    expect(read.product).toMatchObject({
      name: 'Leather loafers',
      brand: 'Arket',
      imageUrl: 'https://shop.example/img/loafers.webp',
      priceMinor: 8995,
      currency: 'EUR',
      stock: 'unknown',
    });
  });

  it('takes the share photo when it is the same picture, bigger', () => {
    const html = `<meta property="og:image" content="https://img.example/a/coat.jpg?imwidth=800">
<meta property="og:image:secure_url" content="https://img.example/a/coat.jpg?imwidth=800">
<script type="application/ld+json">{"@type":"Product","name":"Coat","image":"https://img.example/a/coat.jpg?imwidth=200"}</script>`;
    expect(readProductPage(html, page).product?.imageUrl).toBe(
      'https://img.example/a/coat.jpg?imwidth=800',
    );
    const other = html.replaceAll('/a/coat.jpg?imwidth=800', '/banner.jpg');
    expect(readProductPage(other, page).product?.imageUrl).toBe(
      'https://img.example/a/coat.jpg?imwidth=200',
    );
  });

  it('takes the sale price, not the list price', () => {
    expect(readProductPage(salePricePage, page).product).toMatchObject({
      priceMinor: 55930,
      currency: 'NOK',
      stock: 'in_stock',
    });
  });

  it('falls back to Open Graph product tags', () => {
    const read = readProductPage(metaOnlyPage, page);
    expect(read.product).toEqual({
      name: 'Satin slip dress',
      brand: 'Nelly',
      gtin: null,
      imageUrl: 'https://nlycdn.example/dress.jpg?w=1200&q=80',
      priceMinor: 129900,
      currency: 'SEK',
      stock: 'out_of_stock',
      source: 'meta',
    });
    expect(read.canonicalUrl).toBe('https://nelly.example/se/dress-123/');
  });

  it('finds no product on an article or an empty page', () => {
    expect(readProductPage(articlePage, page).product).toBeNull();
    expect(readProductPage('<html></html>', page).product).toBeNull();
    expect(readProductPage('', page).product).toBeNull();
  });

  it('decodes pages in the charset they name', () => {
    const latin1 = Buffer.from('<title>Jacka i läder</title>', 'latin1');
    expect(pageText(latin1, 'text/html; charset=ISO-8859-1')).toContain('läder');
    const utf8 = Buffer.from('<meta charset="utf-8"><title>Jacka i läder</title>', 'utf8');
    expect(pageText(utf8, 'text/html')).toContain('läder');
  });
});

describe('hostile or odd pages', () => {
  const MB3 = 3 * 1024 * 1024;
  it.each([
    ['unclosed <meta', '<meta '],
    ['unclosed <script', '<script '],
    ['unclosed <link', '<link '],
    ['scripts that never close', '<script>'],
    ['tiny meta tags', '<meta>'],
    ['tiny scripts', '<script></script>'],
    ['ld+json blocks', '<script type="application/ld+json">{}</script>'],
    ['lone brackets', '<'],
    ['attribute soup', '<meta a="'],
  ])('reads 3 MB of %s quickly', (_name, piece) => {
    const html = piece.repeat(Math.ceil(MB3 / piece.length));
    const started = performance.now();
    readProductPage(html, page);
    expect(performance.now() - started).toBeLessThan(300);
  });

  it('ignores odd @type values, control characters and unknown entities', () => {
    const html = `<script type="application/ld+json">[
      {"@type": {"toString": 1}, "name": "Not a product"},
      {"@type": ["Product", {"x": 1}], "name": "Coat\\u0000 &constructor; &toString;", "brand": "Ar\u0000ket",
       "offers": {"price": "100", "priceCurrency": "SEK"}}
    ]</script>`;
    expect(readProductPage(html, page).product).toMatchObject({
      name: 'Coat &constructor; &toString;',
      brand: 'Ar ket',
      priceMinor: 10000,
    });
  });

  it('treats 0 as no price', () => {
    const html = `<script type="application/ld+json">{"@type":"Product","name":"Coat","offers":[
      {"@type":"Offer","price":"0","priceCurrency":"SEK","availability":"InStock"},
      {"@type":"Offer","price":"799","priceCurrency":"SEK","availability":"OutOfStock"}]}</script>`;
    expect(readProductPage(html, page).product).toMatchObject({ priceMinor: 79900 });
    const zero = html.replace('"799"', '"0"');
    expect(readProductPage(zero, page).product).toMatchObject({ priceMinor: null, currency: null });
  });
});

describe('links', () => {
  it('finds the link in shared text and adds https to a bare address', () => {
    expect(linkFromInput('Look at this! https://shop.example/p/1?aff=7 so nice')?.href).toBe(
      'https://shop.example/p/1?aff=7',
    );
    expect(linkFromInput('www.zalando.se/jacka-123.html')?.href).toBe(
      'https://www.zalando.se/jacka-123.html',
    );
    expect(linkFromInput('Get it here: https://shop.example/p/1?aff=x.')?.href).toBe(
      'https://shop.example/p/1?aff=x',
    );
    expect(linkFromInput('(see https://shop.example/p/1)!')?.href).toBe('https://shop.example/p/1');
    expect(linkFromInput('https://shop.example/Coat_(black)')?.href).toBe(
      'https://shop.example/Coat_(black)',
    );
    expect(linkFromInput('"https://shop.example/p/1",')?.href).toBe('https://shop.example/p/1');
    expect(linkFromInput('just words')).toBeNull();
    expect(linkFromInput('ftp://shop.example/file')).toBeNull();
    expect(linkFromInput('javascript:alert(1)')).toBeNull();
  });

  it('keeps every parameter of the posted link', () => {
    const pasted = 'https://Shop.Example/p/1?utm_source=insta&awc=123_abc&size=M#reviews';
    expect(linkFromInput(pasted)?.href).toBe(
      'https://shop.example/p/1?utm_source=insta&awc=123_abc&size=M#reviews',
    );
  });

  it('cleans the shop page: canonical on the same site, tracking and fragment removed', () => {
    const landed = new URL(
      'https://www.shop.example/p/1?utm_source=insta&awc=123&size=M&gclid=g#x',
    );
    expect(shopPageUrl(landed, null)).toBe('https://www.shop.example/p/1?size=M');
    expect(shopPageUrl(landed, 'https://shop.example/p/1')).toBe('https://shop.example/p/1');
    // A canonical link to another site is ignored.
    expect(shopPageUrl(landed, 'https://evil.example/p/1')).toBe(
      'https://www.shop.example/p/1?size=M',
    );
  });
});

describe('public addresses', () => {
  it.each([
    '10.0.0.1',
    '172.16.5.4',
    '192.168.1.1',
    '127.0.0.1',
    '0.0.0.0',
    '169.254.169.254',
    '100.64.0.1',
    '224.0.0.1',
    '255.255.255.255',
    '198.18.0.1',
    '::1',
    '::',
    'fe80::1',
    'fdaa:0:1::3',
    'fc00::1',
    'ff02::1',
    '::ffff:127.0.0.1',
    '::ffff:7f00:1',
    '::ffff:10.0.0.1',
    '64:ff9b::a00:1',
    '2001:db8::1',
    '2002:c000:0204::1',
    '2001:0:4136:e378:8000:63bf:3fff:fdd2',
    '3fff::1',
    'not an ip',
    'fe80::1%eth0',
  ])('%s is not public', (ip) => {
    expect(isPublicAddress(ip)).toBe(false);
  });

  it.each([
    '93.184.216.34',
    '1.1.1.1',
    '2606:4700:4700::1111',
    '2a00:1450:4001:82a::200e',
    '::ffff:1.1.1.1',
    '64:ff9b::101:101',
  ])('%s is public', (ip) => {
    expect(isPublicAddress(ip)).toBe(true);
  });
});
