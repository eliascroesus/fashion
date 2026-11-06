import { currencyDigits, type OfferStock } from '@outfitly/shared';

/**
 * Reads a shop's product page without an HTML library: schema.org JSON-LD
 * first (what Google Shopping reads, so most shops have it), then Open Graph
 * and product meta tags for whatever is still missing.
 */

export interface PageProduct {
  name: string;
  brand: string | null;
  /** 14 digits (shorter barcodes padded with zeros), check digit verified. */
  gtin: string | null;
  imageUrl: string | null;
  priceMinor: number | null;
  currency: string | null;
  stock: OfferStock;
  /** Where the data came from, for the test script and logs. */
  source: 'json-ld' | 'meta' | 'microlink';
}

export interface PageRead {
  product: PageProduct | null;
  /**
   * `<link rel="canonical">`, resolved against the page; null when there's none, or when the
   * product is a size found by this page's own link (the canonical page is its group's).
   */
  canonicalUrl: string | null;
}

const NAMED_ENTITIES = new Map<string, string>(
  Object.entries({
    amp: '&',
    lt: '<',
    gt: '>',
    quot: '"',
    apos: "'",
    nbsp: ' ',
    ndash: '–',
    mdash: '—',
    lsquo: '‘',
    rsquo: '’',
    ldquo: '“',
    rdquo: '”',
    hellip: '…',
    euro: '€',
    pound: '£',
    trade: '™',
    reg: '®',
    copy: '©',
    aring: 'å',
    Aring: 'Å',
    auml: 'ä',
    Auml: 'Ä',
    ouml: 'ö',
    Ouml: 'Ö',
    oslash: 'ø',
    Oslash: 'Ø',
    aelig: 'æ',
    AElig: 'Æ',
    uuml: 'ü',
    Uuml: 'Ü',
    eacute: 'é',
    Eacute: 'É',
    egrave: 'è',
    szlig: 'ß',
  }),
);

export function decodeEntities(text: string): string {
  return text.replace(/&(#x[0-9a-f]+|#\d+|[a-z]+\d*);/gi, (whole, name: string) => {
    if (name.startsWith('#')) {
      const code =
        name[1] === 'x' || name[1] === 'X' ? parseInt(name.slice(2), 16) : Number(name.slice(1));
      return Number.isInteger(code) && code > 0 && code <= 0x10ffff
        ? String.fromCodePoint(code)
        : whole;
    }
    return NAMED_ENTITIES.get(name) ?? whole;
  });
}

// Control characters, NUL included (Postgres refuses it in text).
// eslint-disable-next-line no-control-regex
const CONTROL = /[\u0000-\u001f\u007f]/g;

/** Entities decoded, control characters removed, whitespace collapsed; null when nothing is left. */
function clean(value: unknown, maxLength = 300): string | null {
  if (typeof value === 'number') return String(value);
  if (typeof value !== 'string') return null;
  const text = decodeEntities(value).replace(CONTROL, ' ').replace(/\s+/g, ' ').trim();
  return text === '' ? null : text.slice(0, maxLength).trim();
}

const CURRENCIES = new Set(Intl.supportedValuesOf('currency'));

/**
 * Fraction digits of a currency (2 for SEK, 0 for ISK and JPY), or null if it
 * isn't one. The digits come from the table the app reads prices back with.
 */
export function minorDigits(currency: string): number | null {
  if (!CURRENCIES.has(currency)) return null;
  return currencyDigits(currency);
}

/**
 * A price as written on a page in minor units (öre, cents), or null. Exact:
 * no floating point. Spaces and apostrophes group thousands ("1 299,00"); with
 * both "." and "," the later one is the decimal point ("1.299,00",
 * "1,299.00"); a single "." or "," is a decimal point (schema.org writes
 * prices "1299.00"), except before exactly three digits ("199.000", "1,299"),
 * which could mean either: then there's no price rather than a wrong one.
 */
export function parsePrice(value: unknown, currency: string): number | null {
  const digits = minorDigits(currency);
  if (digits === null) return null;
  let text: string;
  if (typeof value === 'number') {
    if (!Number.isFinite(value) || value < 0) return null;
    text = value.toFixed(Math.max(digits, 2) + 2);
  } else if (typeof value === 'string') {
    const match = /\d[\d\s.,']*/.exec(decodeEntities(value));
    if (!match) return null;
    const plain = match[0].replace(/[\s']/g, '').replace(/[.,]+$/, '');
    const normal = decimalPoint(plain, digits);
    if (normal === null) return null;
    text = normal;
  } else {
    return null;
  }
  const exact = /^(\d+)(?:\.(\d*))?$/.exec(text);
  if (!exact) return null;
  const whole = exact[1] ?? '0';
  const fraction = (exact[2] ?? '').padEnd(digits + 1, '0');
  let minor = Number(whole) * 10 ** digits + Number(fraction.slice(0, digits) || '0');
  if (Number(fraction[digits] ?? '0') >= 5) minor += 1; // round half up
  // A price of 0 is a shop's placeholder, never a real price (it would add nothing to a
  // look's total yet show as free). offers.price_minor is a 32-bit integer.
  return Number.isSafeInteger(minor) && minor > 0 && minor <= 2_000_000_000 ? minor : null;
}

/** Digits with "." as the only (decimal) separator, or null when it's ambiguous. */
function decimalPoint(text: string, digits: number): string | null {
  const lastDot = text.lastIndexOf('.');
  const lastComma = text.lastIndexOf(',');
  if (lastDot !== -1 && lastComma !== -1) {
    const at = Math.max(lastDot, lastComma);
    const thousands = lastDot > lastComma ? ',' : '.';
    const [first = '', ...groups] = text.slice(0, at).split(thousands);
    // "1.299,00" and "12,345.67" yes; "1,2.3" or "1.2,3" (groups not of three) no.
    if (!/^\d{1,3}$/.test(first) || !groups.every((g) => /^\d{3}$/.test(g))) return null;
    return `${first}${groups.join('')}.${text.slice(at + 1)}`;
  }
  const separator = lastDot !== -1 ? '.' : lastComma !== -1 ? ',' : null;
  if (!separator) return text;
  const [first = '', ...rest] = text.split(separator);
  if (rest.length > 1) {
    // "1.299.000" or "1,299,000": thousands, if every group is three digits.
    const grouped = /^\d{1,3}$/.test(first) && rest.every((g) => /^\d{3}$/.test(g));
    return grouped ? `${first}${rest.join('')}` : null;
  }
  const after = rest[0] ?? '';
  const couldBeThousands = after.length === 3 && /^[1-9]\d{0,2}$/.test(first) && digits !== 3;
  return couldBeThousands ? null : `${first}.${after}`;
}

/** A barcode (GTIN-8/12/13/14) padded to 14 digits, or null if it isn't a valid one. */
export function normalizeGtin(value: unknown): string | null {
  const text =
    typeof value === 'number' ? String(value) : typeof value === 'string' ? value.trim() : '';
  if (!/^(\d{8}|\d{12}|\d{13}|\d{14})$/.test(text)) return null;
  const gtin = text.padStart(14, '0');
  if (/^0+$/.test(gtin)) return null;
  let sum = 0;
  for (let i = 0; i < 13; i++) sum += Number(gtin[i]) * (i % 2 === 0 ? 3 : 1);
  return (10 - (sum % 10)) % 10 === Number(gtin[13]) ? gtin : null;
}

/** schema.org availability (a URL or a plain word) or an Open Graph one, as our stock states. */
export function stockOf(value: unknown): OfferStock {
  const word = (typeof value === 'string' ? value : '')
    .replace(/^https?:\/\/schema\.org\//i, '')
    .replace(/[\s_-]/g, '')
    .toLowerCase();
  if (
    [
      'instock',
      'limitedavailability',
      'onlineonly',
      'preorder',
      'presale',
      'backorder',
      'availablefororder',
    ].includes(word)
  ) {
    return 'in_stock';
  }
  if (['outofstock', 'oos', 'soldout', 'discontinued'].includes(word)) return 'out_of_stock';
  return 'unknown';
}

function absolute(value: string | null, base: URL): string | null {
  if (!value) return null;
  try {
    const url = new URL(value, base);
    return url.protocol === 'https:' || url.protocol === 'http:' ? url.href : null;
  } catch {
    return null;
  }
}

// --- HTML bits -------------------------------------------------------------

const ATTRIBUTE = /([^\s=/>"']+)(?:\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s>"']+)))?/g;

function attributes(tag: string): Map<string, string> {
  const found = new Map<string, string>();
  const inner = tag.replace(/^<\s*[a-z]+/i, '').replace(/\/?>$/, '');
  for (const match of inner.matchAll(ATTRIBUTE)) {
    const name = match[1]?.toLowerCase();
    if (name && !found.has(name))
      found.set(name, decodeEntities(match[2] ?? match[3] ?? match[4] ?? ''));
  }
  return found;
}

/** Most tags of one kind read per page: real pages have far fewer. */
const MAX_TAGS = 2000;
/** Longer meta / link tags are skipped (real ones are a few hundred bytes). */
const MAX_TAG_LENGTH = 16 * 1024;

/**
 * Each `<name …>` tag (and with `content`, what's up to its `</name`), in one
 * pass over the page: every search starts where the last one ended, and an
 * unclosed tag ends the scan, so a hostile page can't make it slow. The
 * patterns are a fixed word plus a one-character look-ahead (nothing to
 * backtrack over).
 */
function* elements(
  html: string,
  name: string,
  content: boolean,
): Generator<{ tag: string; content: string }> {
  const opener = new RegExp(`<${name}(?=[\\s/>]|$)`, 'gi');
  const closer = new RegExp(`</${name}(?=[\\s/>]|$)`, 'gi');
  let from = 0;
  for (let found = 0; found < MAX_TAGS; found++) {
    opener.lastIndex = from;
    const open = opener.exec(html);
    if (!open) return;
    const end = html.indexOf('>', open.index);
    if (end === -1) return;
    from = end + 1;
    if (!content) {
      if (end - open.index <= MAX_TAG_LENGTH)
        yield { tag: html.slice(open.index, end + 1), content: '' };
      continue;
    }
    closer.lastIndex = from;
    const close = closer.exec(html);
    if (!close) return;
    const closeEnd = html.indexOf('>', close.index);
    if (closeEnd === -1) return;
    yield { tag: html.slice(open.index, end + 1), content: html.slice(end + 1, close.index) };
    from = closeEnd + 1;
  }
}

function jsonLdBlocks(html: string): unknown[] {
  const blocks: unknown[] = [];
  for (const { tag, content } of elements(html, 'script', true)) {
    if (tag.length > MAX_TAG_LENGTH) continue;
    const type = attributes(tag).get('type')?.trim().toLowerCase();
    if (type !== 'application/ld+json') continue;
    const text = content
      .trim()
      .replace(/^<!--|-->$/g, '')
      .replace(/^\/\*\s*<!\[CDATA\[\s*\*\/|\/\*\s*\]\]>\s*\*\/$/g, '')
      .trim();
    try {
      blocks.push(JSON.parse(text));
    } catch {
      // Raw line breaks, tabs (or other control characters) inside strings are the usual mistake.
      try {
        blocks.push(JSON.parse(text.replace(CONTROL, ' ')));
      } catch {
        // Unreadable block: the meta tags may still have the product.
      }
    }
  }
  return blocks;
}

function metaTags(html: string): Map<string, string> {
  const found = new Map<string, string>();
  for (const { tag } of elements(html, 'meta', false)) {
    const attrs = attributes(tag);
    const key = (
      attrs.get('property') ??
      attrs.get('name') ??
      attrs.get('itemprop')
    )?.toLowerCase();
    const content = attrs.get('content');
    if (key && content !== undefined && !found.has(key)) found.set(key, content);
  }
  return found;
}

function canonicalOf(html: string, base: URL): string | null {
  for (const { tag } of elements(html, 'link', false)) {
    const attrs = attributes(tag);
    const rel = attrs.get('rel')?.toLowerCase().split(/\s+/) ?? [];
    if (rel.includes('canonical')) return absolute(attrs.get('href') ?? null, base);
  }
  return null;
}

// --- JSON-LD -----------------------------------------------------------------

type Node = Record<string, unknown>;

function isNode(value: unknown): value is Node {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function list(value: unknown): unknown[] {
  return Array.isArray(value) ? value : value === undefined || value === null ? [] : [value];
}

function types(node: Node): string[] {
  return list(node['@type'])
    .filter((t): t is string => typeof t === 'string')
    .map((t) => t.replace(/^(https?:\/\/schema\.org\/|schema:)/i, '').toLowerCase());
}

const PRODUCT_TYPES = [
  'product',
  'productgroup',
  'individualproduct',
  'productmodel',
  'someproducts',
];

/** Where a product node sits: the page's own (a block, @graph, mainEntity) or inside something else. */
interface Found {
  node: Node;
  /** Inside a list or another item ("you may also like", a brand's other products…). */
  nested: boolean;
}

/** Keys that lead to the page's own item rather than to some other one. */
const OWN_KEYS = new Set(['@graph', 'mainEntity', 'mainentity', 'about']);

/** Product nodes anywhere in the blocks (in @graph, lists, a WebPage's mainEntity…). */
function productNodes(blocks: unknown[]): Found[] {
  const found: Found[] = [];
  const visit = (value: unknown, depth: number, nested: boolean) => {
    if (depth > 8) return;
    if (Array.isArray(value)) {
      for (const item of value) visit(item, depth + 1, nested);
      return;
    }
    if (!isNode(value)) return;
    if (types(value).some((t) => PRODUCT_TYPES.includes(t))) {
      found.push({ node: value, nested }); // its variants are read with it
      return;
    }
    for (const [key, child] of Object.entries(value)) {
      visit(child, depth + 1, nested || !OWN_KEYS.has(key));
    }
  };
  visit(blocks, 0, false);
  return found;
}

function text(value: unknown): string | null {
  for (const item of list(value)) {
    if (isNode(item)) {
      const inner = clean(item['@value'] ?? item.name);
      if (inner) return inner;
    } else {
      const plain = clean(item);
      if (plain) return plain;
    }
  }
  return null;
}

function imageOf(value: unknown): string | null {
  for (const item of list(value)) {
    if (typeof item === 'string' && item.trim() !== '') return item.trim();
    if (isNode(item)) {
      const url = item.url ?? item.contentUrl;
      if (typeof url === 'string' && url.trim() !== '') return url.trim();
      if (Array.isArray(url) && typeof url[0] === 'string') return url[0];
    }
  }
  return null;
}

function gtinOf(node: Node): string | null {
  for (const key of ['gtin14', 'gtin13', 'gtin12', 'gtin8', 'gtin']) {
    for (const value of list(node[key])) {
      const gtin = normalizeGtin(value);
      if (gtin) return gtin;
    }
  }
  return null;
}

interface PriceRead {
  priceMinor: number;
  currency: string;
  stock: OfferStock;
}

const NOT_THE_PRICE = /listprice|strikethroughprice|msrp|suggestedretailprice/i;

/** One Offer / AggregateOffer's price, in minor units. */
function offerPrices(offer: Node, fallbackCurrency: string | null): PriceRead[] {
  const stock = stockOf(offer.availability);
  const prices: PriceRead[] = [];
  const add = (amount: unknown, currencyValue: unknown) => {
    const currency = (clean(currencyValue) ?? fallbackCurrency)?.toUpperCase() ?? null;
    if (!currency) return;
    const minor = parsePrice(amount, currency);
    if (minor !== null) prices.push({ priceMinor: minor, currency, stock });
  };
  const currency = offer.priceCurrency;
  if (types(offer).includes('aggregateoffer')) {
    add(offer.lowPrice ?? offer.price, currency);
    for (const inner of list(offer.offers)) {
      if (isNode(inner)) prices.push(...offerPrices(inner, clean(currency)));
    }
    return prices;
  }
  if (offer.price !== undefined) add(offer.price, currency);
  else {
    for (const spec of list(offer.priceSpecification)) {
      if (
        !isNode(spec) ||
        NOT_THE_PRICE.test(typeof spec.priceType === 'string' ? spec.priceType : '')
      )
        continue;
      add(spec.price, spec.priceCurrency ?? currency);
    }
  }
  return prices;
}

function pricesOf(node: Node): PriceRead[] {
  const prices: PriceRead[] = [];
  for (const offer of list(node.offers)) {
    if (isNode(offer)) prices.push(...offerPrices(offer, null));
  }
  return prices;
}

/** The lowest price people can pay; in stock if any offer is. */
function bestPrice(all: PriceRead[]): PriceRead | null {
  // Shops put 0 where they have no price (sold-out sizes, "from" placeholders).
  const prices = all.filter((p) => p.priceMinor > 0);
  if (prices.length === 0) return null;
  const counts = new Map<string, number>();
  for (const p of prices) counts.set(p.currency, (counts.get(p.currency) ?? 0) + 1);
  const currency = [...counts.entries()].sort((a, b) => b[1] - a[1])[0]?.[0] ?? '';
  const same = prices.filter((p) => p.currency === currency);
  const inStock = same.filter((p) => p.stock === 'in_stock');
  const pool = inStock.length > 0 ? inStock : same;
  const lowest = pool.reduce((a, b) => (b.priceMinor < a.priceMinor ? b : a));
  const stock =
    inStock.length > 0
      ? 'in_stock'
      : same.every((p) => p.stock === 'out_of_stock')
        ? 'out_of_stock'
        : 'unknown';
  return { priceMinor: lowest.priceMinor, currency, stock };
}

/** A link that names a page: an empty one or a bare `#fragment` would match any page. */
function pageLink(a: unknown): string | null {
  if (typeof a !== 'string') return null;
  const link = a.trim();
  return link === '' || link.startsWith('#') ? null : link;
}

function samePage(a: unknown, page: URL): boolean {
  const link = pageLink(a);
  if (link === null) return false;
  try {
    const url = new URL(link, page);
    return url.hostname === page.hostname && url.pathname === page.pathname;
  } catch {
    return false;
  }
}

/**
 * Whether a variant's URL is this page: same host and path, and every query
 * parameter it has is on the page too. Variants told apart only by the query
 * (`/p/coat?size=xs`, Google's and Shopify's markup) never match the bare
 * product page, so one sold-out size can't stand for the whole product.
 */
function variantOnPage(a: unknown, page: URL): boolean {
  const link = pageLink(a);
  if (link === null) return false;
  try {
    const url = new URL(link, page);
    if (url.hostname !== page.hostname || url.pathname !== page.pathname) return false;
    return [...url.searchParams].every(([key, value]) =>
      page.searchParams.getAll(key).includes(value),
    );
  } catch {
    return false;
  }
}

/**
 * The page's product from its JSON-LD. `variantPage` is true when the product
 * is one size or colour written as a product of its own, found by its offer's
 * link to this page: the shop's canonical link is then the whole group's page
 * (Boozt), so this page, not the canonical one, is where it can be read again.
 */
function fromJsonLd(
  blocks: unknown[],
  page: URL,
): { product: PageProduct; variantPage: boolean } | null {
  const found = productNodes(blocks).filter((f) => text(f.node.name));
  const sellable = (n: Node) => pricesOf(n).length > 0 || list(n.hasVariant).length > 0;
  // The page's own product, not a "you may also like" one: same URL, else one that isn't
  // inside a list or another item, preferably with a price. Products found only inside other
  // things count when they're all one product: several are a category or search page's list.
  const own = found.filter((f) => !f.nested).map((f) => f.node);
  const all = found.map((f) => f.node);
  const oneProduct = new Set(all.map((n) => text(n.name))).size === 1;
  // Sizes or colours as products of their own, each naming its page only in its offer (Boozt).
  const sizeOnPage = own.find((n) =>
    list(n.offers).some((o) => isNode(o) && variantOnPage(o.url, page)),
  );
  const node =
    all.find((n) => samePage(n.url ?? n['@id'], page)) ??
    sizeOnPage ??
    own.find(sellable) ??
    own[0] ??
    (oneProduct ? (all.find(sellable) ?? all[0]) : undefined);
  if (!node) return null;

  const variants = list(node.hasVariant).filter(isNode);
  // The one variant this exact page is (a colour or size page), else all of them for the price.
  const onPage = variants.filter((v) => variantOnPage(v.url ?? v['@id'], page));
  const variant = onPage.length === 1 ? (onPage[0] ?? null) : null;
  let prices = variant ? pricesOf(variant) : [];
  if (prices.length === 0) prices = pricesOf(node);
  if (prices.length === 0) prices = variants.flatMap(pricesOf);
  const best = bestPrice(prices);

  // A variant written as a product of its own names its group (inline or by @id); the brand
  // often sits only there.
  const groupRef = isNode(node.isVariantOf) ? node.isVariantOf : null;
  const group =
    groupRef && typeof groupRef['@id'] === 'string'
      ? (all.find((n) => n !== node && n['@id'] === groupRef['@id']) ?? groupRef)
      : groupRef;
  const brand =
    text(node.brand) ??
    text(isNode(node.manufacturer) ? node.manufacturer.name : null) ??
    (variant ? text(variant.brand) : null) ??
    (group ? text(group.brand) : null);
  // A group's barcodes are per size, so only one variant's (or a plain product's) is kept.
  const gtin = variant ? gtinOf(variant) : variants.length > 0 ? null : gtinOf(node);
  const product: PageProduct = {
    name: text(node.name) ?? '',
    brand,
    gtin,
    imageUrl: absolute(imageOf(variant?.image) ?? imageOf(node.image), page),
    priceMinor: best?.priceMinor ?? null,
    currency: best?.currency ?? null,
    stock: best?.stock ?? stockOf(null),
    source: 'json-ld',
  };
  return { product, variantPage: node === sizeOnPage };
}

function fromMeta(meta: Map<string, string>, page: URL): PageProduct | null {
  const get = (...keys: string[]) => {
    for (const key of keys) {
      const value = clean(meta.get(key));
      if (value) return value;
    }
    return null;
  };
  const amount = get(
    'product:price:amount',
    'og:price:amount',
    'product:sale_price:amount',
    'price',
  );
  const currency =
    get(
      'product:price:currency',
      'og:price:currency',
      'product:sale_price:currency',
      'pricecurrency',
    )?.toUpperCase() ?? null;
  const isProduct = /product/i.test(meta.get('og:type') ?? '') || amount !== null;
  const name = get('og:title', 'twitter:title', 'name');
  if (!isProduct || !name) return null;
  const priceMinor = amount && currency ? parsePrice(amount, currency) : null;
  const siteName = get('og:site_name');
  return {
    name: siteName
      ? name.replace(new RegExp(`\\s*[|–—-]\\s*${escapeRegExp(siteName)}$`, 'i'), '') || name
      : name,
    brand: get('product:brand', 'og:brand', 'brand'),
    gtin: normalizeGtin(
      get(
        'product:ean',
        'product:upc',
        'product:gtin',
        'gtin13',
        'gtin14',
        'gtin12',
        'gtin8',
        'gtin',
      ),
    ),
    imageUrl: absolute(get('og:image:secure_url', 'og:image', 'twitter:image', 'image'), page),
    priceMinor,
    currency: priceMinor === null ? null : currency,
    stock: stockOf(get('product:availability', 'og:availability', 'availability')),
    source: 'meta',
  };
}

function escapeRegExp(text: string): string {
  return text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

/** The width a photo address asks its image server for (`?imwidth=800`, `?size=w1300`), if any. */
function askedWidth(url: URL): number | null {
  let widest: number | null = null;
  for (const [key, value] of url.searchParams) {
    if (!/^(w|wid|width|imwidth|size|sw)$/i.test(key)) continue;
    const digits = /^w?(\d{2,5})$/i.exec(value)?.[1];
    if (digits) widest = Math.max(widest ?? 0, Number(digits));
  }
  return widest;
}

/**
 * JSON-LD's photo, unless the share photo (og:image) is the same picture at
 * another size: shops size share photos for big screens, while some (Zalando)
 * give a 200 px thumbnail in JSON-LD. When both addresses name a width, the
 * wider one wins (Boozt's share photo is the 400 px one).
 */
function biggerPhoto(jsonLd: string | null, share: string | null): string | null {
  if (!jsonLd || !share) return jsonLd ?? share;
  try {
    const a = new URL(jsonLd);
    const b = new URL(share);
    if (a.hostname !== b.hostname || a.pathname !== b.pathname) return jsonLd;
    const widthA = askedWidth(a);
    const widthB = askedWidth(b);
    return widthA !== null && widthB !== null && widthA > widthB ? jsonLd : share;
  } catch {
    return jsonLd;
  }
}

/** The product a shop page describes, or null if it has no product data. */
export function readProductPage(html: string, page: URL): PageRead {
  const meta = metaTags(html);
  const ld = fromJsonLd(jsonLdBlocks(html), page);
  const fromTags = fromMeta(meta, page);
  if (!ld) return { product: fromTags, canonicalUrl: canonicalOf(html, page) };
  // A size or colour found by its own page keeps that page: the canonical one is the group's.
  const canonicalUrl = ld.variantPage ? null : canonicalOf(html, page);
  const share = absolute(
    clean(meta.get('og:image:secure_url')) ?? clean(meta.get('og:image')),
    page,
  );
  const product = { ...ld.product, imageUrl: biggerPhoto(ld.product.imageUrl, share) };
  if (!fromTags) return { product, canonicalUrl };
  // JSON-LD first; the meta tags fill its gaps.
  const usePrice = product.priceMinor === null && fromTags.priceMinor !== null;
  return {
    product: {
      ...product,
      brand: product.brand ?? fromTags.brand,
      gtin: product.gtin ?? fromTags.gtin,
      imageUrl: product.imageUrl ?? fromTags.imageUrl,
      priceMinor: usePrice ? fromTags.priceMinor : product.priceMinor,
      currency: usePrice ? fromTags.currency : product.currency,
      stock: product.stock === 'unknown' ? fromTags.stock : product.stock,
    },
    canonicalUrl,
  };
}

/** Decodes a page's bytes with the charset its server (or a meta tag) names; UTF-8 otherwise. */
export function pageText(body: Buffer, contentType: string): string {
  const fromHeader = /charset=["']?([\w-]+)/i.exec(contentType)?.[1];
  const head = body.subarray(0, 2048).toString('latin1');
  const fromMeta = /<meta[^>]+charset=["']?([\w-]+)/i.exec(head)?.[1];
  const label = (fromHeader ?? fromMeta ?? 'utf-8').toLowerCase();
  try {
    return new TextDecoder(label).decode(body);
  } catch {
    return new TextDecoder('utf-8').decode(body);
  }
}
