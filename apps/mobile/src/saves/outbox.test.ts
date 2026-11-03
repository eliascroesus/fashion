import type { FeedCard } from '@outfitly/shared';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { ApiRequestError } from '../api/client';
import { Outbox, type OutboxDeps, OUTBOX_RULES, type PendingAction } from './outbox';

const LOOK = 'look-1';
const OTHER = 'look-2';

let stored: PendingAction[];
let sent: PendingAction[];
let fail: Error | undefined;
let profile: boolean;
let sessionStarts: number;
let drained: number;

function deps(initial: PendingAction[] = [], overrides: Partial<OutboxDeps> = {}): OutboxDeps {
  stored = initial;
  let k = 0;
  return {
    load: () => [...stored],
    save: (actions) => {
      stored = [...actions];
    },
    send: (pending) => {
      sent.push(pending);
      return fail ? Promise.reject(fail) : Promise.resolve();
    },
    hasProfile: () => profile,
    startSession: () => {
      sessionStarts += 1;
      profile = true;
      return Promise.resolve();
    },
    newId: () => `key-${String(++k)}`,
    onDrained: () => {
      drained += 1;
    },
    random: () => 0,
    timers: {
      set: (fn, ms) => setTimeout(fn, ms),
      clear: (h) => {
        clearTimeout(h as ReturnType<typeof setTimeout>);
      },
    },
    ...overrides,
  };
}

const offline = () => new ApiRequestError(0, 'network_error', 'offline');
const lookOf = (p: PendingAction | undefined) =>
  p && 'lookId' in p.action ? p.action.lookId : undefined;

beforeEach(() => {
  vi.useFakeTimers();
  sent = [];
  fail = undefined;
  profile = true;
  sessionStarts = 0;
  drained = 0;
});

afterEach(() => {
  vi.useRealTimers();
});

describe('Outbox', () => {
  it('sends an action straight away and forgets it once the server has it', async () => {
    const outbox = new Outbox(deps());
    outbox.add({ kind: 'save', lookId: LOOK });
    expect(outbox.savedState(LOOK)).toBe(true);
    await vi.runAllTimersAsync();
    expect(sent.map((p) => p.action)).toEqual([{ kind: 'save', lookId: LOOK }]);
    expect(outbox.size).toBe(0);
    expect(stored).toEqual([]);
    expect(outbox.savedState(LOOK)).toBeUndefined();
    expect(drained).toBe(1);
  });

  it('keeps actions made offline (also across a restart) and sends them in order, same keys', async () => {
    fail = offline();
    const first = new Outbox(deps());
    first.add({ kind: 'save', lookId: LOOK });
    first.add({ kind: 'save', lookId: OTHER });
    first.add({ kind: 'unsave', lookId: LOOK });
    await vi.advanceTimersByTimeAsync(0);
    expect(first.size).toBe(3);
    expect(first.savedState(LOOK)).toBe(false);
    expect(first.savedState(OTHER)).toBe(true);
    const keys = stored.map((p) => p.id);

    // The app is closed and opened again, still offline: nothing is lost.
    const second = new Outbox(deps(stored));
    expect(second.size).toBe(3);
    sent = [];
    fail = undefined; // back online
    await second.flush();
    expect(sent.map((p) => p.id)).toEqual(keys);
    expect(sent.map((p) => p.action.kind)).toEqual(['save', 'save', 'unsave']);
    expect(second.size).toBe(0);
  });

  it('retries after 2 s, doubling up to 30 s, with the same key each time', async () => {
    fail = offline();
    const outbox = new Outbox(deps());
    outbox.add({ kind: 'save', lookId: LOOK });
    await vi.advanceTimersByTimeAsync(0);
    expect(sent).toHaveLength(1);
    await vi.advanceTimersByTimeAsync(1_999);
    expect(sent).toHaveLength(1);
    await vi.advanceTimersByTimeAsync(1);
    expect(sent).toHaveLength(2); // after 2 s
    await vi.advanceTimersByTimeAsync(4_000);
    expect(sent).toHaveLength(3); // after 4 s more
    await vi.advanceTimersByTimeAsync(8_000 + 16_000 + 30_000);
    expect(sent).toHaveLength(6); // 8 s, 16 s, then capped at 30 s
    await vi.advanceTimersByTimeAsync(OUTBOX_RULES.maxRetryAfterMs);
    expect(sent).toHaveLength(7);
    expect(new Set(sent.map((p) => p.id))).toEqual(new Set(['key-1']));

    fail = undefined; // the connection is back: the next retry gets through
    await vi.advanceTimersByTimeAsync(OUTBOX_RULES.maxRetryAfterMs);
    expect(outbox.size).toBe(0);
    await vi.advanceTimersByTimeAsync(5 * 60_000);
    expect(sent).toHaveLength(8); // nothing more once it's empty
  });

  it('drops an action the server refuses for good, and goes on with the rest', async () => {
    const outbox = new Outbox(
      deps([], {
        send: (pending) => {
          sent.push(pending);
          return lookOf(pending) === LOOK
            ? Promise.reject(new ApiRequestError(404, 'not_found', 'Look not found.'))
            : Promise.resolve();
        },
      }),
    );
    outbox.add({ kind: 'save', lookId: LOOK });
    outbox.add({ kind: 'save', lookId: OTHER });
    await vi.runAllTimersAsync();
    expect(sent.map(lookOf)).toEqual([LOOK, OTHER]);
    expect(outbox.size).toBe(0);
  });

  it('retries a refusal that may pass later, but not forever', async () => {
    fail = new ApiRequestError(409, 'idempotency_in_progress', 'Still working.');
    const outbox = new Outbox(deps());
    outbox.add({ kind: 'save', lookId: LOOK });
    await vi.runAllTimersAsync();
    expect(sent).toHaveLength(OUTBOX_RULES.maxRefusals);
    expect(outbox.size).toBe(0);
  });

  it('waits for a login before sending; a waiting save starts a guest session', async () => {
    profile = false;
    const outbox = new Outbox(deps());
    outbox.add({ kind: 'see-less', lookId: OTHER });
    await vi.runAllTimersAsync();
    expect(sent).toHaveLength(0);
    expect(sessionStarts).toBe(0); // "see less" alone never makes an account

    outbox.add({ kind: 'save', lookId: LOOK });
    await vi.runAllTimersAsync();
    expect(sessionStarts).toBe(1);
    expect(sent.map((p) => p.action.kind)).toEqual(['see-less', 'save']);
  });

  it('tries the guest session again later if it could not be made (offline)', async () => {
    profile = false;
    let attempts = 0;
    const outbox = new Outbox(
      deps([], {
        startSession: () => {
          attempts += 1;
          if (attempts < 3) return Promise.reject(new Error('offline'));
          profile = true;
          return Promise.resolve();
        },
      }),
    );
    outbox.add({ kind: 'save', lookId: LOOK });
    await vi.advanceTimersByTimeAsync(0);
    expect(attempts).toBe(1);
    await vi.advanceTimersByTimeAsync(2_000 + 4_000);
    expect(attempts).toBe(3);
    expect(outbox.size).toBe(0);
  });

  it('tells which boards a waiting action puts a look on or takes it off', () => {
    fail = offline();
    const outbox = new Outbox(deps());
    outbox.add({ kind: 'board-add', boardId: 'b1', lookId: LOOK });
    outbox.add({ kind: 'board-add', boardId: 'b2', lookId: LOOK });
    outbox.add({ kind: 'board-remove', boardId: 'b2', lookId: LOOK });
    expect(outbox.boardState('b1', LOOK)).toBe(true);
    expect(outbox.boardState('b2', LOOK)).toBe(false);
    expect(outbox.boardState('b3', LOOK)).toBeUndefined();
    expect(outbox.savedState(LOOK)).toBe(true); // on a board = saved
    outbox.add({ kind: 'unsave', lookId: LOOK });
    expect(outbox.boardState('b1', LOOK)).toBe(false); // unsaving takes it off every board
  });

  it('lists the looks saved by waiting actions, newest first, as they will end up', () => {
    fail = offline();
    const outbox = new Outbox(deps());
    const card = (id: string) => ({ id }) as FeedCard;
    outbox.add({ kind: 'save', lookId: 'a', card: card('a') });
    outbox.add({ kind: 'board-add', boardId: 'b1', lookId: 'b', card: card('b') });
    outbox.add({ kind: 'save', lookId: 'c', card: card('c') });
    outbox.add({ kind: 'unsave', lookId: 'c' });
    expect(outbox.waitingCards().map((c) => [c.id, c.saved])).toEqual([
      ['b', true],
      ['a', true],
    ]);
    expect(outbox.waitingCards('b1').map((c) => c.id)).toEqual(['b']);
    expect(outbox.waitingCards('b2')).toEqual([]);
    outbox.add({ kind: 'save', lookId: 'a', card: card('a') }); // saved again: now the newest
    expect(outbox.waitingCards().map((c) => c.id)).toEqual(['a', 'b']);
  });

  it('tells whether a profile will be followed once everything waiting is sent', () => {
    fail = offline();
    const outbox = new Outbox(deps());
    expect(outbox.followState('author')).toBeUndefined();
    outbox.add({ kind: 'follow', profileId: 'author' });
    expect(outbox.followState('author')).toBe(true);
    outbox.add({ kind: 'unfollow', profileId: 'author' });
    expect(outbox.followState('author')).toBe(false);
    expect(outbox.followState('someone-else')).toBeUndefined();
    expect(outbox.view.followState('author')).toBe(false);
  });

  it('keeps at most 500 actions and forgets everything on clear', () => {
    fail = offline();
    const outbox = new Outbox(deps());
    const listener = vi.fn();
    outbox.subscribe(listener);
    for (let i = 0; i < OUTBOX_RULES.maxKept + 5; i++) {
      outbox.add({ kind: 'save', lookId: `look-${String(i)}` });
    }
    expect(outbox.size).toBe(OUTBOX_RULES.maxKept);
    expect(lookOf(stored[0])).toBe('look-5');
    outbox.clear();
    expect(outbox.size).toBe(0);
    expect(stored).toEqual([]);
    expect(listener).toHaveBeenCalled();
  });
});
