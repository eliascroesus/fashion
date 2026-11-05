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
  readStoredClicks,
  type ShopDeps,
  TAP_LOCK_MS,
} from './shop';

const LOOK = '3f9a2c1b-4d5e-4f60-8a1b-2c3d4e5f6a7b';
const POSTED = 'https://www.shop.test/p/coat?utm_source=outfitly&aff=poster-123&x=a%20b';
const ITEM = { offerId: '7d1e2f3a-4b5c-4d6e-8f70-819a2b3c4d5e', url: POSTED };
const STYLE = { bar: 'bar', controls: 'controls' };
const T0 = Date.parse('2026-11-05T10:00:00.000Z');

const idOf = (n: number) => `00000000-0000-4000-8000-${String(n).padStart(12, '0')}`;

/** What happened, in order: clicks kept and links opened. */
let log: string[];
let kept: ClientClick[];
let ids: number;
/** The fake clock, in ms. */
let clock: number;

function deps(change: Partial<ShopDeps<typeof STYLE>> = {}): ShopDeps<typeof STYLE> {
  return {
    newId: () => idOf(++ids),
    now: () => clock,
    keep: (click) => {
      kept.push(click);
      log.push(`keep ${String(ids)}`);
    },
    open: (url) => {
      log.push(`open ${url}`);
      return Promise.resolve();
    },
    report: (error) => {
      log.push(`report ${error instanceof Error ? error.message : String(error)}`);
    },
    ...change,
  };
}

beforeEach(() => {
  log = [];
  kept = [];
  ids = 0;
  clock = T0;
});

describe('openShop', () => {
  it('keeps the click on the phone first, then opens the link exactly as posted', async () => {
    const openShop = createShopOpener(deps());
    const origin = { source: 'feed_for_you' as const, position: 7 };
    expect(await openShop(LOOK, ITEM, origin, STYLE)).toBe('opened');
    expect(log).toEqual(['keep 1', `open ${POSTED}`]);
    expect(kept).toEqual([
      {
        id: idOf(1),
        lookId: LOOK,
        offerId: ITEM.offerId,
        source: 'feed_for_you',
        position: 7,
        tappedAt: '2026-11-05T10:00:00.000Z',
      },
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

  it('one tap is one click: a quick double tap (the browser not up yet) is ignored', async () => {
    // Android's call returns as soon as the tab is asked for, before it covers the app.
    const openShop = createShopOpener(deps());
    expect(await openShop(LOOK, ITEM, NO_ORIGIN, STYLE)).toBe('opened');
    clock += 150;
    expect(await openShop(LOOK, ITEM, NO_ORIGIN, STYLE)).toBe('busy');
    expect(kept).toHaveLength(1);
  });

  it('Shop works again after a moment, even if the browser never reported back', async () => {
    // iPhone: the call settles when the shop is closed; a dropped presentation never settles.
    const openShop = createShopOpener(deps({ open: () => new Promise(() => undefined) }));
    void openShop(LOOK, ITEM, NO_ORIGIN, STYLE);
    clock += TAP_LOCK_MS - 1;
    expect(await openShop(LOOK, ITEM, NO_ORIGIN, STYLE)).toBe('busy');
    clock += 1;
    void openShop(LOOK, ITEM, NO_ORIGIN, STYLE);
    expect(kept.map((c) => c.id)).toEqual([idOf(1), idOf(2)]);
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
    expect(log).toEqual(['report disk full', `open ${POSTED}`]);
  });

  it("doesn't keep a click the server couldn't read, but still opens the shop", async () => {
    const openShop = createShopOpener(deps());
    expect(await openShop('not-a-look-id', ITEM, NO_ORIGIN, STYLE)).toBe('opened');
    expect(kept).toHaveLength(0);
    expect(log).toHaveLength(2);
    expect(log[0]).toMatch(/^report /);
    expect(log[1]).toBe(`open ${POSTED}`);
  });

  it('only opens web links (and keeps no click for anything else)', async () => {
    const openShop = createShopOpener(deps());
    const bad = { ...ITEM, url: 'javascript:alert(1)' };
    expect(await openShop(LOOK, bad, NO_ORIGIN, STYLE)).toBe('failed');
    expect(kept).toHaveLength(0);
    expect(log).toEqual(['report Shop link is not a web link']);
  });

  it("says when the browser couldn't open, and a later tap tries again", async () => {
    let fail = true;
    const openShop = createShopOpener(
      deps({
        open: () => (fail ? Promise.reject(new Error('no browser')) : Promise.resolve()),
      }),
    );
    expect(await openShop(LOOK, ITEM, NO_ORIGIN, STYLE)).toBe('failed');
    expect(log).toContain('report no browser');
    fail = false;
    clock += TAP_LOCK_MS;
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
    expect(originFromParams('search', '10000')).toEqual({ source: 'search', position: 10_000 });
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
    // Past the furthest place the server takes: no place, rather than a click it refuses.
    expect(originFromParams('search', '10001')).toEqual({ source: 'search', position: null });
    expect(originFromParams('search', '123456')).toEqual({ source: 'search', position: null });
  });

  it('round-trips through the params a card puts on the look', () => {
    const params = originParams('search', 4);
    expect(originFromParams(params.from, params.pos)).toEqual({ source: 'search', position: 4 });
    expect(originParams(undefined, 4)).toEqual({});
  });
});

function tap(n: number): ClientClick {
  return {
    id: idOf(n),
    lookId: LOOK,
    offerId: ITEM.offerId,
    ...NO_ORIGIN,
    tappedAt: '2026-11-05T10:00:00.000Z',
  };
}

describe('clicks kept on the phone', () => {
  it('reads them back, dropping only the ones that no longer fit', () => {
    const stored = JSON.stringify([tap(1), { ...tap(2), position: 10_001 }, { id: 'x' }, tap(3)]);
    expect(readStoredClicks(stored).map((c) => c.id)).toEqual([idOf(1), idOf(3)]);
  });

  it('starts empty when there is nothing, or something unreadable', () => {
    expect(readStoredClicks(undefined)).toEqual([]);
    expect(readStoredClicks('{"not": "a list"}')).toEqual([]);
    expect(readStoredClicks('[1,')).toEqual([]);
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
    let answer: 'ok' | 'offline' | 'lost' | 'no route' = 'ok';
    return {
      rows,
      answer: (a: typeof answer) => {
        answer = a;
      },
      send: (clicks: ClientClick[]) => {
        if (answer === 'offline') {
          return Promise.reject(new ApiRequestError(0, 'network_error', 'offline'));
        }
        if (answer === 'no route') {
          return Promise.reject(new ApiRequestError(404, 'not_found', 'no such route'));
        }
        for (const c of clicks) if (!rows.has(c.id)) rows.set(c.id, c);
        return answer === 'lost'
          ? Promise.reject(new ApiRequestError(0, 'network_error', 'lost'))
          : Promise.resolve();
      },
    };
  }

  function clickQueue(
    send: (clicks: ClientClick[]) => Promise<void>,
    initial: ClientClick[] = [],
    onDropped?: (count: number) => void,
  ) {
    let stored = initial;
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
      onDropped,
    });
    return { queue, stored: () => stored };
  }

  it('sends each tap at once', async () => {
    const shop = server();
    const { queue, stored } = clickQueue(shop.send);
    queue.add(tap(1));
    expect(stored()).toHaveLength(1); // on the phone before anything is sent
    await vi.advanceTimersByTimeAsync(0);
    expect([...shop.rows.keys()]).toEqual([idOf(1)]);
    expect(stored()).toHaveLength(0);
  });

  it('after a restart, sends the clicks still waiting on the phone', async () => {
    const shop = server();
    const { stored } = clickQueue(shop.send, [tap(1), tap(2)]);
    await vi.advanceTimersByTimeAsync(CLICK_RULES.flushAfterMs);
    expect([...shop.rows.keys()]).toEqual([idOf(1), idOf(2)]);
    expect(stored()).toHaveLength(0);
  });

  it('keeps taps made offline and sends them later, once each', async () => {
    const shop = server();
    shop.answer('offline');
    const { queue, stored } = clickQueue(shop.send);
    queue.add(tap(1));
    queue.add(tap(2));
    await vi.advanceTimersByTimeAsync(0);
    expect(shop.rows.size).toBe(0);
    expect(stored().map((c) => c.id)).toEqual([idOf(1), idOf(2)]);

    shop.answer('ok');
    await vi.advanceTimersByTimeAsync(CLICK_RULES.retryAfterMs);
    expect([...shop.rows.keys()]).toEqual([idOf(1), idOf(2)]);
    expect(stored()).toHaveLength(0);
  });

  it('keeps clicks for later when the server has no clicks route yet (404)', async () => {
    const shop = server();
    shop.answer('no route');
    const { queue, stored } = clickQueue(shop.send);
    queue.add(tap(1));
    await vi.advanceTimersByTimeAsync(0);
    expect(stored()).toHaveLength(1);
    shop.answer('ok');
    await vi.advanceTimersByTimeAsync(CLICK_RULES.retryAfterMs);
    expect([...shop.rows.keys()]).toEqual([idOf(1)]);
  });

  it('a click whose answer got lost is sent again with the same id, so it stays one row', async () => {
    const shop = server();
    shop.answer('lost');
    const send = vi.fn(shop.send);
    const { queue, stored } = clickQueue(send);
    queue.add(tap(1));
    await vi.advanceTimersByTimeAsync(0);
    expect(stored()).toHaveLength(1); // the phone doesn't know it arrived

    shop.answer('ok');
    await vi.advanceTimersByTimeAsync(CLICK_RULES.retryAfterMs);
    expect(send).toHaveBeenCalledTimes(2);
    expect(send.mock.calls.map(([clicks]) => clicks.map((c) => c.id))).toEqual([
      [idOf(1)],
      [idOf(1)],
    ]);
    expect(shop.rows.size).toBe(1);
    expect(stored()).toHaveLength(0);
  });

  it(`says when it drops the oldest to keep at most ${String(CLICK_RULES.maxKept)}`, async () => {
    const shop = server();
    shop.answer('offline');
    const dropped = vi.fn();
    const waiting = Array.from({ length: CLICK_RULES.maxKept }, (_, i) => tap(i + 1));
    const { queue, stored } = clickQueue(shop.send, waiting, dropped);
    queue.add(tap(CLICK_RULES.maxKept + 1));
    expect(dropped).toHaveBeenCalledWith(1);
    expect(stored()).toHaveLength(CLICK_RULES.maxKept);
    expect(stored()[0]?.id).toBe(idOf(2));
    await vi.advanceTimersByTimeAsync(0);
  });
});
