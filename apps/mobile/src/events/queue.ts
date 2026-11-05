// Holds events (and Shop clicks) on the phone and sends them in batches.
// Storage, sending and timers are passed in, so it's unit-tested without a phone.
import { type ClientEvent, MAX_EVENT_BATCH } from '@outfitly/shared';
import { ApiRequestError } from '../api/client';
import type { Timers } from '../lib/timers';

export interface QueueRules {
  /** Send as soon as this many are waiting… */
  batchSize: number;
  /** …or this long after the first one arrived. */
  flushAfterMs: number;
  /** After a failed send, wait this long before trying again, twice as long after each further failure… */
  retryAfterMs: number;
  /** …up to this, plus up to 25% at random so phones don't all come back at once. */
  maxRetryAfterMs: number;
  /** Kept on the phone at most (oldest dropped first), e.g. after days offline. */
  maxKept: number;
  /** At most this many in one request. */
  maxBatch: number;
}

/** Impressions: many small ones, so they wait for a batch. */
export const QUEUE_RULES: QueueRules = {
  batchSize: 20,
  flushAfterMs: 10_000,
  retryAfterMs: 30_000,
  maxRetryAfterMs: 15 * 60_000,
  maxKept: 500,
  maxBatch: MAX_EVENT_BATCH,
};

/** Anything the server stores once per id, so sending it again is safe. */
interface WithId {
  id: string;
}

export interface EventQueueDeps<T extends WithId = ClientEvent> {
  load: () => T[];
  save: (events: readonly T[]) => void;
  /** Sends one batch; throws if it didn't arrive. */
  send: (events: T[], idempotencyKey: string) => Promise<void>;
  newKey: () => string;
  timers: Timers;
  /** 0 ≤ n < 1 (tests pass a fixed one). */
  random?: () => number;
  /** Defaults to the impression rules above. */
  rules?: QueueRules;
}

/** Worth sending again later: no connection, a server problem, an expired login or a rate limit. */
function isTemporary(error: unknown): boolean {
  if (!(error instanceof ApiRequestError)) return true;
  return error.status === 0 || error.status >= 500 || [401, 408, 429].includes(error.status);
}

/**
 * Events wait on the phone (they survive the app closing) and go out in
 * batches. A failed batch is sent again later with the same event ids, which
 * the server skips if it already has them, so nothing is counted twice.
 * After a failure nothing is sent until the retry is due (however many events
 * arrive meanwhile), except one try when the app goes to the background.
 */
export class EventQueue<T extends WithId = ClientEvent> {
  private events: T[];
  private timer: unknown = null;
  private sending: Promise<void> | null = null;
  /** Failed sends in a row; while above 0 the queue waits for its retry. */
  private failures = 0;
  private readonly rules: QueueRules;

  constructor(private readonly deps: EventQueueDeps<T>) {
    this.rules = deps.rules ?? QUEUE_RULES;
    this.events = deps.load();
    if (this.events.length > 0) this.schedule(this.rules.flushAfterMs);
  }

  get size(): number {
    return this.events.length;
  }

  /** Kept on the phone before this returns, so it survives the app closing right after. */
  add(event: T): void {
    this.events.push(event);
    if (this.events.length > this.rules.maxKept) {
      this.events.splice(0, this.events.length - this.rules.maxKept);
    }
    this.deps.save(this.events);
    if (this.failures === 0 && this.events.length >= this.rules.batchSize) void this.flush();
    // While a retry is pending this keeps it: schedule never moves an existing timer.
    else this.schedule(this.rules.flushAfterMs);
  }

  /** Sends what is waiting now (e.g. the app is going to the background). */
  flush(): Promise<void> {
    this.sending ??= this.sendAll().finally(() => {
      this.sending = null;
    });
    return this.sending;
  }

  private async sendAll(): Promise<void> {
    while (this.events.length > 0) {
      const batch = this.events.slice(0, this.rules.maxBatch);
      try {
        await this.deps.send(batch, this.deps.newKey());
      } catch (error) {
        if (isTemporary(error)) {
          this.backOff();
          return;
        }
        // The server refuses this batch for good (e.g. an older app's format): drop it.
      }
      const sent = new Set(batch.map((e) => e.id));
      this.events = this.events.filter((e) => !sent.has(e.id));
      this.deps.save(this.events);
    }
    this.failures = 0;
    this.cancelTimer();
  }

  private backOff(): void {
    this.failures += 1;
    const { retryAfterMs, maxRetryAfterMs } = this.rules;
    const wait = Math.min(retryAfterMs * 2 ** (this.failures - 1), maxRetryAfterMs);
    const random = this.deps.random ?? Math.random;
    this.cancelTimer();
    this.schedule(wait * (1 + 0.25 * random()));
  }

  private schedule(ms: number): void {
    if (this.timer !== null) return;
    this.timer = this.deps.timers.set(() => {
      this.timer = null;
      void this.flush();
    }, ms);
  }

  private cancelTimer(): void {
    if (this.timer === null) return;
    this.deps.timers.clear(this.timer);
    this.timer = null;
  }
}
