// Holds events on the phone and sends them in batches. Storage, sending and
// timers are passed in, so it's unit-tested without a phone.
import { type ClientEvent, MAX_EVENT_BATCH } from '@outfitly/shared';
import { ApiRequestError } from '../api/client';
import type { Timers } from '../lib/timers';

export const QUEUE_RULES = {
  /** Send as soon as this many events are waiting… */
  batchSize: 20,
  /** …or this long after the first one arrived. */
  flushAfterMs: 10_000,
  /** After a failed send, try again this much later. */
  retryAfterMs: 30_000,
  /** Kept on the phone at most (oldest dropped first), e.g. after days offline. */
  maxKept: 500,
} as const;

export interface EventQueueDeps {
  load: () => ClientEvent[];
  save: (events: readonly ClientEvent[]) => void;
  /** Sends one batch; throws if it didn't arrive. */
  send: (events: ClientEvent[], idempotencyKey: string) => Promise<void>;
  newKey: () => string;
  timers: Timers;
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
 */
export class EventQueue {
  private events: ClientEvent[];
  private timer: unknown = null;
  private sending: Promise<void> | null = null;

  constructor(private readonly deps: EventQueueDeps) {
    this.events = deps.load();
    if (this.events.length > 0) this.schedule(QUEUE_RULES.flushAfterMs);
  }

  get size(): number {
    return this.events.length;
  }

  add(event: ClientEvent): void {
    this.events.push(event);
    if (this.events.length > QUEUE_RULES.maxKept) {
      this.events.splice(0, this.events.length - QUEUE_RULES.maxKept);
    }
    this.deps.save(this.events);
    if (this.events.length >= QUEUE_RULES.batchSize) void this.flush();
    else this.schedule(QUEUE_RULES.flushAfterMs);
  }

  /** Sends what is waiting now (e.g. the app is going to the background). */
  flush(): Promise<void> {
    this.sending ??= this.sendAll().finally(() => {
      this.sending = null;
    });
    return this.sending;
  }

  private async sendAll(): Promise<void> {
    this.cancelTimer();
    while (this.events.length > 0) {
      const batch = this.events.slice(0, MAX_EVENT_BATCH);
      try {
        await this.deps.send(batch, this.deps.newKey());
      } catch (error) {
        if (isTemporary(error)) {
          this.schedule(QUEUE_RULES.retryAfterMs);
          return;
        }
        // The server refuses this batch for good (e.g. an older app's format): drop it.
      }
      const sent = new Set(batch.map((e) => e.id));
      this.events = this.events.filter((e) => !sent.has(e.id));
      this.deps.save(this.events);
    }
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
