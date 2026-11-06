// Adds the seed looks' shop links from looks.json as look items and checks them (Step 3.5).
import {
  and,
  asc,
  type Db,
  eq,
  gte,
  isNull,
  lookItems,
  lookMedia,
  looks,
  media,
  notInArray,
  offers,
  products,
  sql,
} from '@outfitly/db';
import type { EmbedderClient } from '../../src/ai/embedder.ts';
import type { GeminiClient } from '../../src/ai/gemini.ts';
import { fingerprintPhoto, SpendCapReachedError, spotPhoto } from '../../src/ai/photos.ts';
import type { JobQueue } from '../../src/jobs.ts';
import {
  addLookItem,
  checkLookItem,
  type LinkCheckOutcome,
  removeLookItems,
} from '../../src/links/check.ts';
import { LinkFetchError, type NetworkPolicy } from '../../src/links/fetch.ts';
import { copyProductPhoto, fingerprintProduct } from '../../src/links/product-photos.ts';
import { parseLink, readShopLink, saveLinkRead } from '../../src/links/resolve.ts';
import type { PhotoStorage } from '../../src/storage.ts';
import { readSeedFile, seedLookId, seedPhotoId } from './looks.ts';

/** A link read this recently isn't read from the shop again (same as `POST /v1/links/resolve`). */
const RECENT_MS = 60 * 60 * 1000;

export interface SeedItemsOptions {
  db: Db;
  storage: PhotoStorage;
  folder: string;
  /** Without it, photos aren't read and checks that need the AI wait. */
  gemini: GeminiClient | null;
  /** Without it, nothing is fingerprinted, so checks wait. */
  embedder: EmbedderClient | null;
  dailyCapMicros: number;
  /** Tests point names at a local shop. */
  network?: NetworkPolicy;
  /** At least this long between two requests to the same site (default 1 s; tests use 0). */
  minGapMs?: number;
  log?: (line: string) => void;
}

export interface SeedItemRow {
  /** The look's first photo (its name in looks.json). */
  look: string;
  link: string;
  product: string | null;
  /** The check's outcome, or `problem` when the link or look couldn't be used. */
  outcome: LinkCheckOutcome['outcome'] | 'problem';
  /** Why: a link check reason, what it waits for, or the problem. */
  reason: string | null;
  similarity: number | null;
}

export interface SeedItemsResult {
  rows: SeedItemRow[];
  /** Items of these looks whose links are no longer in the file (removed). */
  removed: number;
  /** What the AI cost during this run, in millionths of a dollar. */
  costMicros: number;
  /** The daily AI spend cap stopped the run early. */
  capReached: boolean;
}

/**
 * Makes the seed looks' items match the `links` in looks.json (looks without
 * `links` are left alone): reads each link like `POST /v1/links/resolve`,
 * copies and fingerprints the product photo, reads the look's photos with the
 * AI if that hasn't happened yet, and runs each new item's check right away.
 * Safe to run again: a link already on the look keeps its check.
 */
export async function seedLookItems(options: SeedItemsOptions): Promise<SeedItemsResult> {
  const { db, storage, folder, gemini, embedder, log = () => undefined } = options;
  const entries = (await readSeedFile(folder)).filter((entry) => entry.links !== undefined);
  const started = new Date();
  const rows: SeedItemRow[] = [];
  const toCheck: { row: SeedItemRow; lookItemId: string }[] = [];
  // Checks run below, one at a time, instead of through the job queue.
  const queue: JobQueue = { send: () => Promise.resolve(null) };
  const photoDeps = { db, storage, gemini, embedder, dailyCapMicros: options.dailyCapMicros };
  let removed = 0;
  let capReached = false;
  const pace = pacer(options.minGapMs ?? 1000);

  for (const entry of entries) {
    const first = entry.photos[0] ?? '';
    const lookId = seedLookId(await seedPhotoId(folder, first));
    const [look] = await db
      .select({ id: looks.id })
      .from(looks)
      .where(and(eq(looks.id, lookId), isNull(looks.deletedAt)));
    const links = entry.links ?? [];
    if (!look) {
      for (const link of links) {
        rows.push({
          look: first,
          link,
          product: null,
          outcome: 'problem',
          reason: 'look not loaded (run pnpm seed:looks first)',
          similarity: null,
        });
      }
      continue;
    }

    if (!capReached) capReached = !(await readLookPhotos(photoDeps, lookId, log));

    const offerIds: string[] = [];
    for (const link of links) {
      const row: SeedItemRow = {
        look: first,
        link,
        product: null,
        outcome: 'problem',
        reason: null,
        similarity: null,
      };
      rows.push(row);
      try {
        const offer = await offerFor(options, link, pace);
        row.product = offer.product;
        offerIds.push(offer.offerId);
        const item = await addLookItem(db, queue, { lookId, offerId: offer.offerId });
        toCheck.push({ row, lookItemId: item.id });
      } catch (error) {
        if (!(error instanceof LinkFetchError)) throw error;
        row.reason = `link: ${error.problem}`;
        log(`  ${link}: ${error.message}`);
        // A link that can't be read this time keeps the item it already has.
        const known = await knownOffer(db, link, options.network);
        if (known) offerIds.push(known);
      }
    }

    // Links taken out of the file come off the look (their review items close).
    const gone = await db
      .select({ id: lookItems.id })
      .from(lookItems)
      .where(
        and(
          eq(lookItems.lookId, lookId),
          isNull(lookItems.deletedAt),
          ...(offerIds.length > 0 ? [notInArray(lookItems.offerId, offerIds)] : []),
        ),
      );
    await removeLookItems(
      db,
      gone.map((g) => g.id),
    );
    removed += gone.length;
  }

  const checkDeps = { db, storage, gemini, dailyCapMicros: options.dailyCapMicros };
  for (const { row, lookItemId } of toCheck) {
    const [item] = await db
      .select({ status: lookItems.status, matchScore: lookItems.matchScore })
      .from(lookItems)
      .where(eq(lookItems.id, lookItemId));
    if (item && item.status !== 'pending') {
      // Checked on an earlier run: report what it decided.
      row.outcome = item.status;
      row.similarity = item.matchScore;
      row.reason = await lastReason(db, lookItemId);
      continue;
    }
    if (capReached) {
      row.outcome = 'waiting';
      row.reason = 'daily AI spend cap';
      continue;
    }
    try {
      const result = await checkLookItem(checkDeps, lookItemId);
      row.outcome = result.outcome;
      row.reason = result.reason;
      row.similarity = 'similarity' in result ? result.similarity : null;
    } catch (error) {
      if (!(error instanceof SpendCapReachedError)) throw error;
      capReached = true;
      row.outcome = 'waiting';
      row.reason = 'daily AI spend cap';
    }
  }

  const { rows: cost } = await db.execute<{ micros: string }>(
    sql`SELECT coalesce(sum(cost_micros), 0)::text AS micros FROM ai_calls
         WHERE created_at >= ${started.toISOString()}`,
  );
  return { rows, removed, costMicros: Number(cost[0]?.micros ?? 0), capReached };
}

/**
 * The look's photos read by the AI (garments) and fingerprinted, if that
 * hasn't happened yet. False when the daily spend cap stopped it.
 */
async function readLookPhotos(
  deps: Parameters<typeof spotPhoto>[0],
  lookId: string,
  log: (line: string) => void,
): Promise<boolean> {
  const photos = await deps.db
    .select({ id: media.id, spotStatus: media.spotStatus })
    .from(lookMedia)
    .innerJoin(media, eq(media.id, lookMedia.mediaId))
    .where(and(eq(lookMedia.lookId, lookId), eq(media.status, 'ready'), isNull(media.deletedAt)))
    .orderBy(asc(lookMedia.position));
  for (const photo of photos) {
    if (deps.gemini && photo.spotStatus === null) {
      try {
        const read = await spotPhoto(deps, photo.id);
        log(`  read photo ${photo.id}: ${read.outcome}`);
      } catch (error) {
        if (error instanceof SpendCapReachedError) return false;
        log(`  photo ${photo.id} not read: ${(error as Error).message}`);
      }
    }
    if (deps.embedder) {
      try {
        await fingerprintPhoto(deps, photo.id);
      } catch (error) {
        log(`  photo ${photo.id} not fingerprinted: ${(error as Error).message}`);
      }
    }
  }
  return true;
}

type Pace = (url: string) => Promise<void>;

/** Waits so that two requests to the same site are at least `gapMs` apart (polite to shops). */
function pacer(gapMs: number): Pace {
  const last = new Map<string, number>();
  return async (url) => {
    const host = new URL(url).hostname;
    const wait = (last.get(host) ?? 0) + gapMs - Date.now();
    if (wait > 0) await new Promise((done) => setTimeout(done, wait));
    last.set(host, Date.now());
  };
}

/** The offer a link already has, if any (without reading the shop). */
async function knownOffer(
  db: Db,
  link: string,
  network: NetworkPolicy | undefined,
): Promise<string | null> {
  let url: URL;
  try {
    url = parseLink(link, network);
  } catch {
    return null;
  }
  const [offer] = await db
    .select({ id: offers.id })
    .from(offers)
    .where(and(eq(offers.url, url.href), isNull(offers.deletedAt)));
  return offer?.id ?? null;
}

/** The offer for a link: read from the shop (unless read in the last hour), photo copied in. */
async function offerFor(
  options: SeedItemsOptions,
  link: string,
  pace: Pace,
): Promise<{ offerId: string; product: string }> {
  const { db, storage, embedder, network } = options;
  const url = parseLink(link, network);
  const [known] = await db
    .select({ offerId: offers.id, productId: products.id, product: products.name })
    .from(offers)
    .innerJoin(products, eq(products.id, offers.productId))
    .where(
      and(
        eq(offers.url, url.href),
        isNull(offers.deletedAt),
        isNull(products.deletedAt),
        gte(offers.lastCheckedAt, new Date(Date.now() - RECENT_MS)),
      ),
    );
  let offerId: string;
  let productId: string;
  if (known) {
    offerId = known.offerId;
    productId = known.productId;
  } else {
    await pace(url.href);
    const read = await readShopLink(url, { network });
    const saved = await saveLinkRead(db, read);
    offerId = saved.offerId;
    productId = saved.productId;
  }
  const photoDeps = { db, storage, embedder, network };
  try {
    const [photo] = await db
      .select({ imageUrl: products.imageUrl, copied: products.imageMediaId })
      .from(products)
      .where(eq(products.id, productId));
    if (photo?.imageUrl && !photo.copied) await pace(photo.imageUrl);
    await copyProductPhoto(photoDeps, productId);
    if (embedder) await fingerprintProduct(photoDeps, productId);
  } catch (error) {
    // The check waits for the photo (or sends it to review): the link itself is fine.
    options.log?.(`  ${link}: product photo not ready (${(error as Error).message})`);
  }
  const [product] = await db
    .select({ name: products.name })
    .from(products)
    .where(eq(products.id, productId));
  return { offerId, product: product?.name ?? '' };
}

async function lastReason(db: Db, lookItemId: string): Promise<string | null> {
  const { rows } = await db.execute<{ reason: string | null }>(
    sql`SELECT reason FROM link_checks WHERE look_item_id = ${lookItemId}
         ORDER BY created_at DESC LIMIT 1`,
  );
  return rows[0]?.reason ?? null;
}
