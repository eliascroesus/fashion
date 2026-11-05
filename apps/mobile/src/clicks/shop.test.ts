import type { ClientClick } from '@outfitly/shared';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { ApiRequestError } from '../api/client';
import { EventQueue } from '../events/queue';
import {
  CLICK_RULES,
  createShopOpener,
  NO_ORIGIN,
  originFromParams,
  originParams,
  type ShopDeps,
} from './shop';

const LOOK = '3f9a2c1b-4d5e-4f60-8a1b-2c3d4e5f6a7b';
const POSTED = 'https://www.shop.test/p/coat?utm_source=outfitly&aff=poster-123&x=a%20b';
const ITEM = { offerId: '7d1e2f3a-4b5c-4d6e-8f70-819a2b3c4d5e', url: POSTED };
const STYLE = { bar: 'bar', controls: 'controls' };

/** What happened, in order: clicks kept and links opened. */
let log: string[];
let kept: ClientClick[];
let ids: number;

function deps(change: Partial<ShopDeps<typeof STYLE>> = {}): ShopDeps<typeof STYLE> {
  return {
    newId: () => `click-${String(++ids)}`,
    keep: (click) => {
      kept.push(click);
      log.push(`keep ${click.id}`);
    },
    open: (url) => {
      log.push(`open ${url}`);
      return Promise.resolve();
    },
    report: (error) => {
      log.push(`report ${String(error)}`);
    },
    ...change,
  };
}

beforeEach(() => {
  log = [];
  kept = [];
  ids = 0;
});

describe('openShop', () => {
  it('keeps the click on the phone first, then opens the link exactly as posted', async () => {
    const openShop = createShopOpener(deps());
    const origin = { source: 'feed_for_you' as const, position: 7 };
    expect(await openShop(LOOK, ITEM, origin, STYLE)).toBe('opened');
    expect(log).toEqual(['keep click-1', `open ${POSTED}`]);
    expect(kept).toEqual([
      { id: 'click-1', lookId: LOOK, offerId: ITEM.offerId, source: 'feed_for_you', position: 7 },
    ]);
  });

  it('records a look opened from a link with no list or place', async () => {
    const openShop = createShopOpener(deps());
    await openShop(LOOK, ITEM, NO_ORIGIN, STYLE);
    expect(kept[0]).toMatchObject({ source: null, position: null });
  });

  it('passes the theme colours to the browser', async () => {
    const open = vi.fn(() => Promise.resolve());
    const openShop = createShopOpener(deps({ open }));
    await openShop(LOOK, ITEM, NO_ORIGIN, STYLE);
    expect(open).toHaveBeenCalledWith(POSTED, STYLE);
  });

  it('one tap is one click: taps while the shop is opening or open do nothing', async () => {
    let close: () => void = () => undefined;
    const openShop = createShopOpener(
      deps({
        open: (url) => {
          log.push(`open ${url}`);
          return new Promise<void>((resolve) => {
            close = resolve;
          });
        },
      }),
    );
    const first = openShop(LOOK, ITEM, NO_ORIGIN, STYLE);
    expect(await openShop(LOOK, ITEM, NO_ORIGIN, STYLE)).toBe('busy');
    expect(await openShop(LOOK, ITEM, NO_ORIGIN, STYLE)).toBe('busy');
    close();
    expect(await first).toBe('opened');
    expect(kept.map((c) => c.id)).toEqual(['click-1']);

    // Back from the shop, the next tap is a new click with a new id.
    const again = openShop(LOOK, ITEM, NO_ORIGIN, STYLE);
    close();
    await again;
    expect(kept.map((c) => c.id)).toEqual(['click-1', 'click-2']);
  });

  it('still opens the shop when the click could not be kept', async () => {
    const openShop = createShopOpener(
      deps({
        keep: () => {
          throw new Error('disk full');
        },
      }),
    );
    expect(await openShop(LOOK, ITEM, NO_ORIGIN, STYLE)).toBe('opened');
    expect(log).toEqual(['report Error: disk full', `open ${POSTED}`]);
  });

  it("says when the browser couldn't open, and lets the next tap try again", async () => {
    let fail = true;
    const openShop = createShopOpener(
      deps({
        open: () => (fail ? Promise.reject(new Error('no browser')) : Promise.resolve()),
      }),
    );
    expect(await openShop(LOOK, ITEM, NO_ORIGIN, STYLE)).toBe('failed');
    expect(log).toContain('report Error: no browser');
    fail = false;
    expect(await openShop(LOOK, ITEM, NO_ORIGIN, STYLE)).toBe('opened');
  });
});

describe('where the look was opened from', () => {
  it('reads the card list and place from the route params', () => {
    expect(originFromParams('feed_for_you', '12')).toEqual({
      source: 'feed_for_you',
      position: 12,
    });
    expect(originFromParams('board', '0')).toEqual({ source: 'board', position: 0 });
    expect(originFromParams('more_like_this', undefined)).toEqual({
      source: 'more_like_this',
      position: null,
    });
  });

  it('ignores anything else (an old link, a typo, a made-up place)', () => {
    expect(originFromParams(undefined, undefined)).toEqual(NO_ORIGIN);
    expect(originFromParams('somewhere', '3')).toEqual(NO_ORIGIN);
    expect(originFromParams(['feed_for_you'], '3')).toEqual(NO_ORIGIN);
    expect(originFromParams('search', '-1')).toEqual({ source: 'search', position: null });
    expect(originFromParams('search', '2.5')).toEqual({ source: 'search', position: null });
    expect(originFromParams('search', '123456')).toEqual({ source: 'search', position: null });
  });

  it('round-trips through the params a card puts on the look', () => {
    const params = originParams('search', 4);
    expect(originFromParams(params.from, params.pos)).toEqual({ source: 'search', position: 4 });
    expect(originParams(undefined, 4)).toEqual({});
  });
});

describe('the click queue', () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  /** A server that stores each click id once, like `POST /v1/clicks`. */
  function server() {
    const rows = new Map<string, ClientClick>();
    let online = true;
    let loseAnswers = false;
    return {
      rows,
      setOnline: (on: boolean) => {
        online = on;
      },
      setLoseAnswers: (lose: boolean) => {
        loseAnswers = lose;
      },
      send: (clicks: ClientClick[]) => {
        if (!online) return Promise.reject(new ApiRequestError(0, 'network_error', 'offline'));
        for (const c of clicks) if (!rows.has(c.id)) rows.set(c.id, c);
        return loseAnswers
          ? Promise.reject(new ApiRequestError(0, 'network_error', 'lost'))
          : Promise.resolve();
      },
    };
  }

  function clickQueue(send: (clicks: ClientClick[]) => Promise<void>) {
    let stored: ClientClick[] = [];
    let keys = 0;
    const queue = new EventQueue<ClientClick>({
      load: () => [...stored],
      save: (clicks) => {
        stored = [...clicks];
      },
      send,
      newKey: () => `key-${String(++keys)}`,
      random: () => 0,
      timers: {
        set: (fn, ms) => setTimeout(fn, ms),
        clear: (h) => {
          clearTimeout(h as ReturnType<typeof setTimeout>);
        },
      },
      rules: CLICK_RULES,
    });
    return { queue, stored: () => stored };
  }

  function tap(n: number): ClientClick {
    return { id: `click-${String(n)}`, lookId: LOOK, offerId: ITEM.offerId, ...NO_ORIGIN };
  }

  it('sends each tap at once', async () => {
    const shop = server();
    const { queue, stored } = clickQueue(shop.send);
    queue.add(tap(1));
    expect(stored()).toHaveLength(1); // on the phone before anything is sent
    await vi.advanceTimersByTimeAsync(0);
    expect([...shop.rows.keys()]).toEqual(['click-1']);
    expect(stored()).toHaveLength(0);
  });

  it('keeps taps made offline and sends them later, once each', async () => {
    const shop = server();
    shop.setOnline(false);
    const { queue, stored } = clickQueue(shop.send);
    queue.add(tap(1));
    queue.add(tap(2));
    await vi.advanceTimersByTimeAsync(0);
    expect(shop.rows.size).toBe(0);
    expect(stored().map((c) => c.id)).toEqual(['click-1', 'click-2']);

    shop.setOnline(true);
    await vi.advanceTimersByTimeAsync(CLICK_RULES.retryAfterMs);
    expect([...shop.rows.keys()]).toEqual(['click-1', 'click-2']);
    expect(stored()).toHaveLength(0);
  });

  it('a click whose answer got lost is sent again with the same id, so it stays one row', async () => {
    const shop = server();
    shop.setLoseAnswers(true);
    const send = vi.fn(shop.send);
    const { queue, stored } = clickQueue(send);
    queue.add(tap(1));
    await vi.advanceTimersByTimeAsync(0);
    expect(stored()).toHaveLength(1); // the phone doesn't know it arrived

    shop.setLoseAnswers(false);
    await vi.advanceTimersByTimeAsync(CLICK_RULES.retryAfterMs);
    expect(send).toHaveBeenCalledTimes(2);
    expect(send.mock.calls.map(([clicks]) => clicks.map((c) => c.id))).toEqual([
      ['click-1'],
      ['click-1'],
    ]);
    expect(shop.rows.size).toBe(1);
    expect(stored()).toHaveLength(0);
  });
});
