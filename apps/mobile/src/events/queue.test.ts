import type { ClientEvent } from '@outfitly/shared';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { ApiRequestError } from '../api/client';
import { EventQueue, type EventQueueDeps, QUEUE_RULES } from './queue';

let n = 0;
function event(): ClientEvent {
  n += 1;
  const id = `00000000-0000-4000-8000-${String(n).padStart(12, '0')}`;
  return {
    id,
    name: 'impression',
    lookId: id,
    position: n,
    source: 'feed_for_you',
    occurredAt: '2026-11-03T10:00:00.000Z',
  };
}

let stored: ClientEvent[];
let sent: { ids: string[]; key: string }[];
let fail: Error | undefined;

function deps(initial: ClientEvent[] = []): EventQueueDeps {
  stored = initial;
  let k = 0;
  return {
    load: () => [...stored],
    save: (events) => {
      stored = [...events];
    },
    send: (events, key) => {
      sent.push({ ids: events.map((e) => e.id), key });
      return fail ? Promise.reject(fail) : Promise.resolve();
    },
    newKey: () => `key-${String(++k)}`,
    random: () => 0,
    timers: {
      set: (fn, ms) => setTimeout(fn, ms),
      clear: (h) => {
        clearTimeout(h as ReturnType<typeof setTimeout>);
      },
    },
  };
}

beforeEach(() => {
  vi.useFakeTimers();
  sent = [];
  fail = undefined;
});

afterEach(() => {
  vi.useRealTimers();
});

describe('EventQueue', () => {
  it('keeps events on the phone and sends them 10 s after the first one', async () => {
    const queue = new EventQueue(deps());
    queue.add(event());
    queue.add(event());
    expect(stored).toHaveLength(2);
    await vi.advanceTimersByTimeAsync(QUEUE_RULES.flushAfterMs - 1);
    expect(sent).toEqual([]);
    await vi.advanceTimersByTimeAsync(1);
    expect(sent).toHaveLength(1);
    expect(sent[0]?.ids).toHaveLength(2);
    expect(stored).toEqual([]);
  });

  it(`sends straight away once ${String(QUEUE_RULES.batchSize)} are waiting`, async () => {
    const queue = new EventQueue(deps());
    for (let i = 0; i < QUEUE_RULES.batchSize; i++) queue.add(event());
    await vi.advanceTimersByTimeAsync(0);
    expect(sent).toHaveLength(1);
    expect(sent[0]?.ids).toHaveLength(QUEUE_RULES.batchSize);
  });

  it('sends what is waiting on flush (app going to the background)', async () => {
    const queue = new EventQueue(deps());
    queue.add(event());
    await queue.flush();
    expect(sent).toHaveLength(1);
    expect(queue.size).toBe(0);
  });

  it('retries a failed batch later with the same event ids', async () => {
    const queue = new EventQueue(deps());
    queue.add(event());
    fail = new ApiRequestError(0, 'network_error', 'offline');
    await queue.flush();
    expect(queue.size).toBe(1);
    fail = undefined;
    await vi.advanceTimersByTimeAsync(QUEUE_RULES.retryAfterMs);
    expect(sent).toHaveLength(2);
    expect(sent[1]?.ids).toEqual(sent[0]?.ids);
    expect(queue.size).toBe(0);
  });

  it('sends nothing more while waiting to retry, however many events arrive', async () => {
    const queue = new EventQueue(deps());
    fail = new ApiRequestError(503, 'service_unavailable', 'down');
    for (let i = 0; i < QUEUE_RULES.batchSize; i++) queue.add(event());
    await vi.advanceTimersByTimeAsync(0);
    expect(sent).toHaveLength(1);
    // One impression a second for the whole wait: still no new request.
    for (let s = 0; s < 29; s++) {
      queue.add(event());
      await vi.advanceTimersByTimeAsync(1000);
    }
    expect(sent).toHaveLength(1);
    await vi.advanceTimersByTimeAsync(1000);
    expect(sent).toHaveLength(2);
  });

  it('waits twice as long after each failure in a row, up to 15 minutes', async () => {
    const queue = new EventQueue(deps());
    fail = new ApiRequestError(0, 'network_error', 'offline');
    queue.add(event());
    await queue.flush();
    const times: number[] = [];
    let last = Date.now();
    for (let i = 0; i < 7; i++) {
      const before = sent.length;
      while (sent.length === before) await vi.advanceTimersByTimeAsync(1000);
      times.push((Date.now() - last) / 1000);
      last = Date.now();
    }
    expect(times).toEqual([30, 60, 120, 240, 480, 900, 900]);
    fail = undefined;
    await vi.advanceTimersByTimeAsync(900_000);
    expect(queue.size).toBe(0);
  });

  it('drops a batch the server refuses for good, so the queue never gets stuck', async () => {
    const queue = new EventQueue(deps());
    queue.add(event());
    fail = new ApiRequestError(400, 'validation_failed', 'bad');
    await queue.flush();
    expect(queue.size).toBe(0);
  });

  it('sends events left from the last time the app ran', async () => {
    new EventQueue(deps([event(), event()]));
    await vi.advanceTimersByTimeAsync(QUEUE_RULES.flushAfterMs);
    expect(sent[0]?.ids).toHaveLength(2);
  });

  it(`keeps at most ${String(QUEUE_RULES.maxKept)}, dropping the oldest`, async () => {
    fail = new ApiRequestError(503, 'service_unavailable', 'down');
    const queue = new EventQueue(deps());
    const first = event();
    queue.add(first);
    for (let i = 0; i < QUEUE_RULES.maxKept; i++) queue.add(event());
    await vi.advanceTimersByTimeAsync(0);
    expect(queue.size).toBe(QUEUE_RULES.maxKept);
    expect(stored.some((e) => e.id === first.id)).toBe(false);
  });

  it('sends in batches of at most 50, each with its own key', async () => {
    fail = new ApiRequestError(0, 'network_error', 'offline');
    const queue = new EventQueue(deps());
    for (let i = 0; i < 120; i++) queue.add(event());
    await vi.advanceTimersByTimeAsync(0);
    fail = undefined;
    sent = [];
    await queue.flush();
    expect(sent.map((s) => s.ids.length)).toEqual([50, 50, 20]);
    expect(new Set(sent.map((s) => s.key)).size).toBe(3);
  });
});
