// What a tap on Shop does, with the phone parts passed in so it's unit-tested.
import {
  CLICK_SOURCES,
  type ClickSource,
  type ClientClick,
  type LookItem,
  MAX_CLICK_BATCH,
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
};

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
  const position = typeof pos === 'string' && /^\d{1,5}$/.test(pos) ? Number(pos) : null;
  return source === null ? NO_ORIGIN : { source, position };
}

/** The route params a card puts on the look it opens. */
export function originParams(
  source: ClickSource | undefined,
  position: number,
): { from?: ClickSource; pos?: string } {
  return source === undefined ? {} : { from: source, pos: String(position) };
}

export type ShopResult = 'opened' | 'busy' | 'failed';

export interface ShopDeps<Style> {
  newId: () => string;
  /** Keeps the click on the phone before it returns, and sends it soon. */
  keep: (click: ClientClick) => void;
  /** Opens the link in the in-app browser; settles when it's closed (iPhone) or shown (Android). */
  open: (url: string, style: Style) => Promise<unknown>;
  report: (error: unknown) => void;
}

/**
 * A tap on Shop: the click is made (a new random click id) and kept on the
 * phone first, then the shop opens with the link exactly as posted, so the
 * poster's affiliate tags stay. Sending happens in the background and never
 * holds the shop up; a click that can't be kept is reported but the shop
 * still opens. Taps while the shop is opening or open do nothing, so one tap
 * is one click. Resolves to what happened: opened, busy (a tap while the
 * shop was already opening) or failed (the browser couldn't open).
 */
export function createShopOpener<Style>(deps: ShopDeps<Style>) {
  let busy = false;
  return async function openShop(
    lookId: string,
    item: Pick<LookItem, 'offerId' | 'url'>,
    origin: LookOrigin,
    style: Style,
  ): Promise<ShopResult> {
    if (busy) return 'busy';
    busy = true;
    try {
      try {
        deps.keep({ id: deps.newId(), lookId, offerId: item.offerId, ...origin });
      } catch (error) {
        deps.report(error);
      }
      await deps.open(item.url, style);
      return 'opened';
    } catch (error) {
      deps.report(error);
      return 'failed';
    } finally {
      busy = false;
    }
  };
}
