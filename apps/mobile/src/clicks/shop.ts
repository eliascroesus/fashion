// What a tap on Shop does, with the phone parts passed in so it's unit-tested.
import {
  CLICK_SOURCES,
  type ClickSource,
  type ClientClick,
  clientClickSchema,
  type LookItem,
  MAX_CLICK_BATCH,
  MAX_FEED_POSITION,
} from '@outfitly/shared';
import type { QueueRules } from '../events/queue';

/** Each tap is sent at once; offline, it waits on the phone and is retried like events. */
export const CLICK_RULES: QueueRules = {
  batchSize: 1,
  flushAfterMs: 2_000,
  retryAfterMs: 30_000,
  maxRetryAfterMs: 15 * 60_000,
  maxKept: 500,
  maxBatch: MAX_CLICK_BATCH,
  // An API without the clicks route yet (an older server): keep the clicks for later.
  alsoTemporary: [404],
};

/**
 * After a tap, further taps are ignored this long: one tap is one click,
 * even when a quick double tap reaches Shop before the browser covers it.
 * Time-limited, so a browser that never reports back can't block Shop.
 */
export const TAP_LOCK_MS = 1500;

/** Which card of which list the look was opened from (none for a link). */
export interface LookOrigin {
  source: ClickSource | null;
  position: number | null;
}

export const NO_ORIGIN: LookOrigin = { source: null, position: null };

/** The look page's `from` and `pos` route params, as the card that opened it set them. */
export function originFromParams(from: unknown, pos: unknown): LookOrigin {
  const source = (CLICK_SOURCES as readonly unknown[]).includes(from)
    ? (from as ClickSource)
    : null;
  if (source === null) return NO_ORIGIN;
  const place = typeof pos === 'string' && /^\d{1,5}$/.test(pos) ? Number(pos) : null;
  return { source, position: place !== null && place <= MAX_FEED_POSITION ? place : null };
}

/** The route params a card puts on the look it opens. */
export function originParams(
  source: ClickSource | undefined,
  position: number,
): { from?: ClickSource; pos?: string } {
  return source === undefined ? {} : { from: source, pos: String(position) };
}

/**
 * Clicks kept on the phone, as stored. Each is checked on its own: one that
 * doesn't fit (e.g. from an older app version) is dropped, never the rest.
 */
export function readStoredClicks(raw: string | undefined): ClientClick[] {
  let list: unknown;
  try {
    list = JSON.parse(raw ?? '[]');
  } catch {
    return [];
  }
  if (!Array.isArray(list)) return [];
  return list.flatMap((c) => {
    const parsed = clientClickSchema.safeParse(c);
    return parsed.success ? [parsed.data] : [];
  });
}

export type ShopResult = 'opened' | 'busy' | 'failed';

export interface ShopDeps<Style> {
  newId: () => string;
  /** Milliseconds, like Date.now (tests pass a fake clock). */
  now: () => number;
  /** Keeps the click on the phone before it returns, and sends it soon. */
  keep: (click: ClientClick) => void;
  /** Opens the link in the in-app browser. */
  open: (url: string, style: Style) => Promise<unknown>;
  report: (error: unknown) => void;
}

/**
 * A tap on Shop: the click is made (a new random click id, the tap time) and
 * kept on the phone first, then the shop opens with the link exactly as
 * posted, so the poster's affiliate tags stay. Sending happens in the
 * background and never holds the shop up; a click that can't be kept is
 * reported but the shop still opens. Taps within TAP_LOCK_MS of the last one
 * are ignored, so one tap is one click. Only web links open. Resolves to what
 * happened: opened, busy (an ignored tap) or failed (a bad link, or the
 * browser couldn't open).
 */
export function createShopOpener<Style>(deps: ShopDeps<Style>) {
  let lockedUntil = 0;
  return async function openShop(
    lookId: string,
    item: Pick<LookItem, 'offerId' | 'url'>,
    origin: LookOrigin,
    style: Style,
  ): Promise<ShopResult> {
    const now = deps.now();
    if (now < lockedUntil) return 'busy';
    lockedUntil = now + TAP_LOCK_MS;
    if (!/^https?:\/\//i.test(item.url)) {
      deps.report(new Error('Shop link is not a web link'));
      return 'failed';
    }
    const click = clientClickSchema.safeParse({
      id: deps.newId(),
      lookId,
      offerId: item.offerId,
      ...origin,
      tappedAt: new Date(now).toISOString(),
    });
    try {
      if (click.success) deps.keep(click.data);
      else deps.report(click.error);
    } catch (error) {
      deps.report(error);
    }
    try {
      await deps.open(item.url, style);
      return 'opened';
    } catch (error) {
      deps.report(error);
      return 'failed';
    }
  };
}
