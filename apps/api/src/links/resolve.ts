import { and, type Db, eq, isNull, media, ne, offers, products, sql } from '@outfitly/db';
import type { LinkProblem, ResolvedLink } from '@outfitly/shared';
import { ApiError } from '../errors.ts';
import { isFlagOn } from '../flags.ts';
import type { JobQueue } from '../jobs.ts';
import { toMediaResponse } from '../media/pipeline.ts';
import type { PhotoStorage } from '../storage.ts';
import {
  checkUrl,
  isTemporary,
  LinkFetchError,
  type NetworkPolicy,
  PUBLIC_INTERNET,
  safeFetch,
} from './fetch.ts';
import { MICROLINK_FLAG, readWithMicrolink } from './microlink.ts';
import { type PageProduct, pageText, readProductPage } from './parse.ts';
import { PRODUCT_QUEUES } from './product-photos.ts';
import { fitsLinkLimit, linkFromInput, shopPageUrl, siteOf } from './urls.ts';

/** Pages above this are read only this far: product data is near the top (or not there at all). */
const PAGE_BYTES = 3 * 1024 * 1024;
/** A link read this recently is answered from our database, without asking the shop again. */
const RECENT_MS = 60 * 60 * 1000;
/** Price changes kept per offer. */
const MAX_PRICE_HISTORY = 100;

export interface LinkDeps {
  db: Db;
  queue: JobQueue;
  storage: PhotoStorage;
  /** Tests point names at a local shop. */
  network?: NetworkPolicy;
}

export interface PriceChange {
  at: string;
  priceMinor: number;
  currency: string;
}

export interface LinkRead {
  /** The link as given (affiliate tags kept): becomes `offers.url`. */
  url: string;
  /** The shop's own product page, tracking removed: `offers.page_url`. */
  pageUrl: string;
  product: PageProduct;
  /** The page was larger than we read. */
  truncated: boolean;
}

/** Another reader for pages we could open but found no product data on (Microlink). */
export type FallbackReader = (pageUrl: string) => Promise<PageProduct | null>;

export function linkProblem(problem: LinkProblem, message: string): LinkFetchError {
  return new LinkFetchError(problem, message);
}

/** The link in what was pasted, checked before anything is fetched. Throws `LinkFetchError`. */
export function parseLink(input: string, network: NetworkPolicy = PUBLIC_INTERNET): URL {
  const url = linkFromInput(input);
  if (!url) throw linkProblem('bad_link', "That doesn't look like a shop link.");
  if (!fitsLinkLimit(url.href)) throw linkProblem('bad_link', 'The link is too long.');
  checkUrl(url, network);
  return url;
}

/**
 * Reads a shop link: follows its redirects and reads the product from the
 * page. A page we could open but found no product data on goes to the
 * fallback reader, if any. A shop that turns readers away (`blocked`) is left
 * alone: no other reader is sent past its bot protection. Throws
 * `LinkFetchError`. Writes nothing.
 */
export async function readShopLink(
  url: URL,
  options: { network?: NetworkPolicy; fallback?: FallbackReader | null },
): Promise<LinkRead> {
  let finalUrl = url;
  let product: PageProduct | null = null;
  let canonicalUrl: string | null = null;
  let truncated = false;
  let failure: LinkFetchError | null = null;
  try {
    const page = await safeFetch(url, {
      accept: 'text/html,application/xhtml+xml;q=0.9,*/*;q=0.5',
      maxBytes: PAGE_BYTES,
      overLimit: 'truncate',
      contentTypes: ['text/html', 'application/xhtml+xml'],
      network: options.network,
    });
    finalUrl = page.url;
    truncated = page.truncated;
    const read = readProductPage(pageText(page.body, page.contentType), page.url);
    product = read.product;
    canonicalUrl = read.canonicalUrl;
  } catch (error) {
    if (!(error instanceof LinkFetchError)) throw error;
    failure = error;
  }
  if (!product && options.fallback && failure === null) {
    product = await options.fallback(finalUrl.href).catch(() => null);
  }
  if (!product) {
    throw failure ?? linkProblem('no_product', 'We found no product on that page.');
  }
  if (product.imageUrl && !fitsLinkLimit(product.imageUrl)) {
    product = { ...product, imageUrl: null };
  }
  return { url: url.href, pageUrl: shopPageUrl(finalUrl, canonicalUrl), product, truncated };
}

type Tx = Parameters<Parameters<Db['transaction']>[0]>[0];
type Product = typeof products.$inferSelect;

interface Saved {
  offerId: string;
  productId: string;
  outcome: 'created' | 'updated';
  copyPhoto: boolean;
}

/** Waits for (and holds until the transaction ends) a lock on one key of a kind. */
async function lock(tx: Tx, kind: string, key: string): Promise<void> {
  await tx.execute(sql`SELECT pg_advisory_xact_lock(hashtext(${kind}), hashtext(${key}))`);
}

/** Brands compared loosely: "H&M" = "h & m", "Filippa K" = "FILIPPA-K", "Acné" = "Acne". */
function brandKey(brand: string | null): string {
  return (brand ?? '')
    .normalize('NFKD')
    .replace(/\p{M}/gu, '')
    .toLowerCase()
    .replace(/[^\p{L}\p{N}]/gu, '');
}

function barcodesAgree(a: string | null, b: string | null): boolean {
  return a === null || b === null || a === b;
}

async function liveProduct(tx: Tx, id: string): Promise<Product | null> {
  const [row] = await tx
    .select()
    .from(products)
    .where(and(eq(products.id, id), isNull(products.deletedAt)));
  return row ?? null;
}

/**
 * Which product a read is. Only the read itself decides (what the link
 * showed before doesn't): a link that now lands on another page, or a page
 * whose barcode changed, is another product, and the shared product stays as
 * it was.
 * - `page`: the link's own product if it's still the same page, else the
 *   product of another live offer on the same shop page; its barcode must
 *   agree. The read updates it.
 * - `barcode`: a live product with the same barcode and the same brand (both
 *   known), unless it already has a different page on the same shop (two
 *   pages of one shop are two products). The read only fills its gaps.
 */
async function matchProduct(
  tx: Tx,
  read: LinkRead,
  sameLink: typeof offers.$inferSelect | undefined,
): Promise<{ product: Product; how: 'page' | 'barcode' } | null> {
  const found = read.product;
  if (sameLink?.pageUrl === read.pageUrl) {
    const own = await liveProduct(tx, sameLink.productId);
    if (own && barcodesAgree(own.gtin, found.gtin)) return { product: own, how: 'page' };
  }
  const onPage = await tx
    .select({ product: products })
    .from(offers)
    .innerJoin(products, eq(products.id, offers.productId))
    .where(
      and(
        eq(offers.pageUrl, read.pageUrl),
        isNull(offers.deletedAt),
        isNull(products.deletedAt),
        sameLink ? ne(offers.id, sameLink.id) : undefined,
      ),
    )
    .orderBy(offers.createdAt)
    .limit(20);
  const shared = onPage.find((row) => barcodesAgree(row.product.gtin, found.gtin));
  if (shared) return { product: shared.product, how: 'page' };

  if (!found.gtin || !found.brand) return null;
  const [byBarcode] = await tx
    .select()
    .from(products)
    .where(and(eq(products.gtin, found.gtin), isNull(products.deletedAt)));
  if (!byBarcode || brandKey(byBarcode.brand) !== brandKey(found.brand)) return null;
  const pages = await tx
    .select({ pageUrl: offers.pageUrl })
    .from(offers)
    .where(and(eq(offers.productId, byBarcode.id), isNull(offers.deletedAt)));
  // The same page with or without www. / m. is still the same page.
  const here = new URL(read.pageUrl);
  const otherPageHere = pages.some((p) => {
    const there = new URL(p.pageUrl);
    return (
      siteOf(there.hostname) === siteOf(here.hostname) &&
      `${there.pathname}${there.search}` !== `${here.pathname}${here.search}`
    );
  });
  return otherPageHere ? null : { product: byBarcode, how: 'barcode' };
}

/**
 * Creates or updates the product and the offer for one read. The same link is
 * the same offer (a removed one comes back); which product it shows is
 * decided by `matchProduct`, and the offer moves when that changes. A later
 * re-check of an offer (Step 3.9) can read its `page_url` and save the read
 * with the offer's own `url`: the same rules apply.
 */
export async function saveLinkRead(db: Db, read: LinkRead, now = new Date()): Promise<Saved> {
  const { product: found } = read;
  return db.transaction(async (tx) => {
    // The link, then its shop, then the barcode: always in this order, so no deadlocks.
    await lock(tx, 'offer-link', read.url);
    await lock(tx, 'link-resolve', siteOf(new URL(read.pageUrl).hostname));
    if (found.gtin) await lock(tx, 'product-gtin', found.gtin);

    const [sameLink] = await tx.select().from(offers).where(eq(offers.url, read.url));
    const match = await matchProduct(tx, read, sameLink);
    let productId: string;
    let copyPhoto: boolean;
    if (match) {
      productId = match.product.id;
      copyPhoto = await updateProduct(tx, match.product, found, match.how === 'page');
    } else {
      productId = await insertProduct(tx, found);
      copyPhoto = found.imageUrl !== null;
    }

    const values = {
      productId,
      pageUrl: read.pageUrl,
      priceMinor: found.priceMinor,
      currency: found.currency,
      stock: found.stock,
      lastCheckedAt: now,
      deletedAt: null,
    };
    if (sameLink) {
      // A link now showing another item starts that item's price history afresh.
      const history =
        sameLink.productId === productId ? (sameLink.priceHistory as PriceChange[]) : [];
      await tx
        .update(offers)
        .set({ ...values, priceHistory: withPrice(history, found, now) })
        .where(eq(offers.id, sameLink.id));
      return { offerId: sameLink.id, productId, outcome: 'updated', copyPhoto };
    }
    const [created] = await tx
      .insert(offers)
      .values({ ...values, url: read.url, priceHistory: withPrice([], found, now) })
      .returning({ id: offers.id });
    if (!created) throw new Error('Offer not saved.');
    return { offerId: created.id, productId, outcome: 'created', copyPhoto };
  });
}

/** History gets an entry when the price (or currency) is new; unknown prices aren't entries. */
function withPrice(history: PriceChange[], found: PageProduct, now: Date): PriceChange[] {
  if (found.priceMinor === null || found.currency === null) return history;
  const last = history.at(-1);
  if (last?.priceMinor === found.priceMinor && last.currency === found.currency) return history;
  const entry = { at: now.toISOString(), priceMinor: found.priceMinor, currency: found.currency };
  return [...history, entry].slice(-MAX_PRICE_HISTORY);
}

/** Whether no other product holds the barcode (removed ones too: barcodes are unique). */
async function barcodeFree(tx: Tx, gtin: string, productId: string | null): Promise<boolean> {
  const [other] = await tx
    .select({ id: products.id })
    .from(products)
    .where(
      productId
        ? and(eq(products.gtin, gtin), ne(products.id, productId))
        : eq(products.gtin, gtin),
    )
    .limit(1);
  return other === undefined;
}

async function insertProduct(tx: Tx, found: PageProduct): Promise<string> {
  const [created] = await tx
    .insert(products)
    .values({
      name: found.name,
      brand: found.brand,
      gtin: found.gtin && (await barcodeFree(tx, found.gtin, null)) ? found.gtin : null,
      imageUrl: found.imageUrl,
    })
    .returning({ id: products.id });
  if (!created) throw new Error('Product not saved.');
  return created.id;
}

/**
 * Updates a product from a read: from its own page the read's values win, from
 * a barcode match it only fills gaps. Returns whether its photo needs
 * (re)copying.
 */
async function updateProduct(
  tx: Tx,
  current: Product,
  found: PageProduct,
  ownPage: boolean,
): Promise<boolean> {
  // A product's barcode never changes; one it lacks is added if no other product has it.
  const gtin =
    current.gtin ??
    (found.gtin && (await barcodeFree(tx, found.gtin, current.id)) ? found.gtin : null);
  const next = ownPage
    ? {
        name: found.name,
        brand: found.brand ?? current.brand,
        imageUrl: found.imageUrl ?? current.imageUrl,
      }
    : {
        name: current.name,
        brand: current.brand ?? found.brand,
        imageUrl: current.imageUrl ?? found.imageUrl,
      };
  await tx
    .update(products)
    .set({ ...next, gtin })
    .where(eq(products.id, current.id));
  return (
    next.imageUrl !== null && (next.imageUrl !== current.imageUrl || current.imageMediaId === null)
  );
}

/** The API answer for an offer and its product. */
export async function resolvedLinkAnswer(
  db: Db,
  storage: PhotoStorage,
  offerId: string,
  outcome: ResolvedLink['outcome'],
): Promise<ResolvedLink> {
  const [row] = await db
    .select({ offer: offers, product: products, photo: media })
    .from(offers)
    .innerJoin(products, eq(products.id, offers.productId))
    .leftJoin(media, and(eq(media.id, products.imageMediaId), isNull(media.deletedAt)))
    .where(eq(offers.id, offerId));
  if (!row) throw new ApiError(404, 'not_found', 'Offer not found.');
  const { offer, product, photo } = row;
  const image = photo ? toMediaResponse(photo, storage) : null;
  return {
    outcome,
    product: {
      id: product.id,
      name: product.name,
      brand: product.brand,
      category: product.category,
      gtin: product.gtin,
      // Only our own copy is ever shown; it follows within seconds of the first read.
      image:
        image?.urls && image.width && image.height && image.thumbhash && image.dominantColor
          ? {
              width: image.width,
              height: image.height,
              thumbhash: image.thumbhash,
              dominantColor: image.dominantColor,
              urls: image.urls,
            }
          : null,
    },
    offer: {
      id: offer.id,
      url: offer.url,
      pageUrl: offer.pageUrl,
      priceMinor: offer.priceMinor,
      currency: offer.currency,
      stock: offer.stock,
      lastCheckedAt: offer.lastCheckedAt?.toISOString() ?? null,
    },
  };
}

function unreadable(error: LinkFetchError): ApiError {
  return new ApiError(422, 'link_unreadable', error.message, {
    problem: error.problem,
    temporary: isTemporary(error),
    ...(error.httpStatus === null ? {} : { shopStatus: error.httpStatus }),
  });
}

/** A link problem that may go away (a slow, down or busy shop): worth trying again later. */
export function isTemporaryLinkError(error: unknown): boolean {
  return (
    error instanceof ApiError &&
    error.code === 'link_unreadable' &&
    (error.details as { temporary?: unknown } | undefined)?.temporary === true
  );
}

/** `POST /v1/links/resolve`: a pasted link in, the product and offer out (created or updated). */
export async function resolveLink(
  deps: LinkDeps,
  profileId: string,
  input: string,
): Promise<ResolvedLink> {
  const { db, queue, storage } = deps;
  const network = deps.network ?? PUBLIC_INTERNET;
  let url: URL;
  try {
    url = parseLink(input, network);
  } catch (error) {
    if (error instanceof LinkFetchError) throw unreadable(error);
    throw error;
  }

  const [known] = await db
    .select({
      id: offers.id,
      lastCheckedAt: offers.lastCheckedAt,
      productId: products.id,
      shopPhoto: products.imageUrl,
      copiedPhoto: products.imageMediaId,
    })
    .from(offers)
    .innerJoin(products, eq(products.id, offers.productId))
    .where(and(eq(offers.url, url.href), isNull(offers.deletedAt), isNull(products.deletedAt)));
  if (known?.lastCheckedAt && Date.now() - known.lastCheckedAt.getTime() < RECENT_MS) {
    // A photo copy or fingerprint that never happened (a lost job) is asked for again.
    const copyPhoto = known.shopPhoto !== null && known.copiedPhoto === null;
    await queueProductWork(queue, db, known.productId, copyPhoto);
    return resolvedLinkAnswer(db, storage, known.id, 'recent');
  }

  const fallback: FallbackReader | null = (await isFlagOn(db, MICROLINK_FLAG, profileId))
    ? (pageUrl) => readWithMicrolink(pageUrl, { network: deps.network })
    : null;
  let read: LinkRead;
  try {
    read = await readShopLink(url, { network: deps.network, fallback });
  } catch (error) {
    if (error instanceof LinkFetchError) throw unreadable(error);
    throw error;
  }
  const saved = await saveLinkRead(db, read);
  await queueProductWork(queue, db, saved.productId, saved.copyPhoto);
  return resolvedLinkAnswer(db, storage, saved.offerId, saved.outcome);
}

/** Copies a new shop photo in, or fingerprints a copied one that has no fingerprint yet. */
export async function queueProductWork(
  queue: JobQueue,
  db: Db,
  productId: string,
  copyPhoto: boolean,
): Promise<void> {
  if (copyPhoto) {
    await queue.send(PRODUCT_QUEUES.productPhoto, { productId }, { singletonKey: productId });
    return;
  }
  const [product] = await db
    .select({
      photoStatus: media.status,
      hasFingerprint: sql<boolean>`${products.embedding} is not null`,
    })
    .from(products)
    .innerJoin(media, eq(media.id, products.imageMediaId))
    .where(eq(products.id, productId));
  if (product?.photoStatus === 'ready' && !product.hasFingerprint) {
    await queue.send(PRODUCT_QUEUES.productFingerprint, { productId }, { singletonKey: productId });
  }
}
