// Holds save actions on the phone until the server has them. Storage,
// sending, the session and timers are passed in, so it's unit-tested
// without a phone.
import type { FeedCard } from '@outfitly/shared';
import { ApiRequestError } from '../api/client';
import type { Timers } from '../lib/timers';

/**
 * Something the user did that the server must learn about, in order. Saves
 * keep the card, so Saved can show the look before the server has it.
 */
export type SaveAction =
  | { kind: 'save'; lookId: string; card?: FeedCard }
  | { kind: 'unsave'; lookId: string }
  | { kind: 'board-add'; boardId: string; lookId: string; card?: FeedCard }
  | { kind: 'board-remove'; boardId: string; lookId: string }
  | { kind: 'see-less'; lookId: string }
  | { kind: 'follow'; profileId: string }
  | { kind: 'unfollow'; profileId: string };

export interface PendingAction {
  /** Also the request's Idempotency-Key: every retry of this action reuses it. */
  id: string;
  action: SaveAction;
  /** Refusals that may pass later (403, 409…); the action is dropped after too many. */
  refusals?: number;
}

export const OUTBOX_RULES = {
  /** After a failed send, wait this long, twice as long after each further failure… */
  retryAfterMs: 2_000,
  /** …up to this (plus up to 25% at random), so a reconnect is noticed within about 30 s. */
  maxRetryAfterMs: 30_000,
  /** Kept on the phone at most (oldest dropped first). */
  maxKept: 500,
  /** An action the server keeps refusing (but not for good) is dropped after this many tries. */
  maxRefusals: 10,
} as const;

export interface OutboxDeps {
  load: () => PendingAction[];
  save: (actions: readonly PendingAction[]) => void;
  /** Sends one action as the active profile; throws if it didn't arrive. */
  send: (pending: PendingAction) => Promise<void>;
  /** Whether requests can act as a profile right now. */
  hasProfile: () => boolean;
  /** Makes a guest session (only asked while a save is waiting); throws if it can't. */
  startSession: () => Promise<void>;
  newId: () => string;
  timers: Timers;
  /** An action reached the server (called before it stops counting as waiting). */
  onSent?: (pending: PendingAction) => void;
  /** Nothing is waiting any more, after at least one action was sent or dropped. */
  onDrained?: () => void;
  /** 0 ≤ n < 1 (tests pass a fixed one). */
  random?: () => number;
}

/** The outbox's answers at one moment (see Outbox.view). */
export interface OutboxView {
  version: number;
  savedState: (lookId: string) => boolean | undefined;
  followState: (profileId: string) => boolean | undefined;
  boardState: (boardId: string, lookId: string) => boolean | undefined;
  waitingCards: (boardId?: string) => FeedCard[];
}

type Failure = 'retry' | 'refused' | 'drop';

/**
 * No connection, a server problem, an expired login or a rate limit: retry.
 * 403/409 may pass later (e.g. mid sign-in): retry a few times. Any other
 * 4xx won't change (the look was deleted): drop.
 */
function classify(error: unknown): Failure {
  if (!(error instanceof ApiRequestError)) return 'retry';
  const { status } = error;
  if (status === 0 || status >= 500 || [401, 408, 429].includes(status)) return 'retry';
  if (status === 403 || status === 409) return 'refused';
  return 'drop';
}

/** The kinds that need a profile badly enough to start a guest session for (the first save). */
const NEEDS_SESSION = new Set<SaveAction['kind']>(['save', 'board-add']);

/**
 * Save actions wait on the phone (they survive the app closing) and are sent
 * one at a time, in order, as soon as there is a profile to act as. A failed
 * send is retried with the same key, so the server never does it twice.
 */
export class Outbox {
  private pending: PendingAction[];
  private timer: unknown = null;
  private sending: Promise<void> | null = null;
  private failures = 0;
  private changes = 0;
  private cachedView: OutboxView | null = null;
  private readonly listeners = new Set<() => void>();

  constructor(private readonly deps: OutboxDeps) {
    this.pending = deps.load();
  }

  get size(): number {
    return this.pending.length;
  }

  /**
   * What is waiting, as one object that is replaced whenever that changes
   * (React re-renders with it; read it with savedState, boardState, waitingCards).
   */
  get view(): OutboxView {
    if (this.cachedView?.version !== this.changes) {
      this.cachedView = {
        version: this.changes,
        savedState: (lookId) => this.savedState(lookId),
        followState: (profileId) => this.followState(profileId),
        boardState: (boardId, lookId) => this.boardState(boardId, lookId),
        waitingCards: (boardId) => this.waitingCards(boardId),
      };
    }
    return this.cachedView;
  }

  /** Records an action and tries to send it straight away. */
  add(action: SaveAction): void {
    this.pending.push({ id: this.deps.newId(), action });
    if (this.pending.length > OUTBOX_RULES.maxKept) {
      this.pending.splice(0, this.pending.length - OUTBOX_RULES.maxKept);
    }
    this.changed();
    void this.flush();
  }

  /**
   * Whether the look is saved once everything waiting has been sent, or
   * undefined when nothing waiting changes it.
   */
  savedState(lookId: string): boolean | undefined {
    let saved: boolean | undefined;
    for (const { action } of this.pending) {
      if (!('lookId' in action) || action.lookId !== lookId) continue;
      if (action.kind === 'save' || action.kind === 'board-add') saved = true;
      else if (action.kind === 'unsave') saved = false;
    }
    return saved;
  }

  /** Whether a waiting action puts the look on (true) or takes it off (false) the board. */
  boardState(boardId: string, lookId: string): boolean | undefined {
    let inBoard: boolean | undefined;
    for (const { action } of this.pending) {
      if (!('lookId' in action) || action.lookId !== lookId) continue;
      if (action.kind === 'unsave') inBoard = false;
      else if (action.kind === 'board-add' && action.boardId === boardId) inBoard = true;
      else if (action.kind === 'board-remove' && action.boardId === boardId) inBoard = false;
    }
    return inBoard;
  }

  /** Whether the profile will be followed once everything is sent, or undefined when nothing waiting changes it. */
  followState(profileId: string): boolean | undefined {
    let following: boolean | undefined;
    for (const { action } of this.pending) {
      if (!('profileId' in action) || action.profileId !== profileId) continue;
      following = action.kind === 'follow';
    }
    return following;
  }

  /**
   * Looks saved by an action still waiting (on `boardId` if given), newest
   * first, as they'll be once everything is sent.
   */
  waitingCards(boardId?: string): FeedCard[] {
    const cards = new Map<string, FeedCard>();
    for (const { action } of this.pending) {
      if (!('card' in action) || !action.card) continue;
      if (boardId !== undefined && (action.kind !== 'board-add' || action.boardId !== boardId)) {
        continue;
      }
      cards.delete(action.lookId);
      cards.set(action.lookId, { ...action.card, saved: true });
    }
    return [...cards.values()]
      .filter((card) =>
        boardId === undefined
          ? this.savedState(card.id) === true
          : this.boardState(boardId, card.id) === true,
      )
      .reverse();
  }

  /** Sends what is waiting now (e.g. the app came back, or a profile appeared). */
  flush(): Promise<void> {
    this.sending ??= this.sendAll().finally(() => {
      this.sending = null;
    });
    return this.sending;
  }

  /** Forgets everything waiting (sign-out: it belonged to the old login). */
  clear(): void {
    this.pending = [];
    this.failures = 0;
    this.cancelTimer();
    this.changed();
  }

  subscribe(listener: () => void): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  /** Resolves once a send in progress (if any) is over, whatever its outcome. */
  settled(): Promise<void> {
    return this.sending ?? Promise.resolve();
  }

  private async sendAll(): Promise<void> {
    let done = 0;
    while (this.pending.length > 0) {
      if (!this.deps.hasProfile()) {
        // Wait for a login, unless a save is waiting: that starts a guest session.
        if (!this.pending.some((p) => NEEDS_SESSION.has(p.action.kind))) return;
        try {
          await this.deps.startSession();
        } catch {
          this.backOff();
          return;
        }
        if (!this.deps.hasProfile()) {
          this.backOff();
          return;
        }
      }

      const next = this.pending[0];
      if (!next) break;
      try {
        await this.deps.send(next);
      } catch (error) {
        const failure = classify(error);
        const refusals = (next.refusals ?? 0) + (failure === 'refused' ? 1 : 0);
        if (failure === 'retry' || (failure === 'refused' && refusals < OUTBOX_RULES.maxRefusals)) {
          if (failure === 'refused') {
            this.pending = this.pending.map((p) => (p.id === next.id ? { ...p, refusals } : p));
            this.deps.save(this.pending);
          }
          this.backOff();
          return;
        }
        // Refused for good (or too often): drop it and go on.
        this.remove(next.id);
        done += 1;
        continue;
      }
      // Before it leaves the list, so screens never fall back to an older state in between.
      this.deps.onSent?.(next);
      this.remove(next.id);
      done += 1;
    }
    this.failures = 0;
    this.cancelTimer();
    if (done > 0) this.deps.onDrained?.();
  }

  private remove(id: string): void {
    this.pending = this.pending.filter((p) => p.id !== id);
    this.changed();
  }

  private changed(): void {
    this.changes += 1;
    this.deps.save(this.pending);
    for (const listener of this.listeners) listener();
  }

  private backOff(): void {
    this.failures += 1;
    const { retryAfterMs, maxRetryAfterMs } = OUTBOX_RULES;
    const wait = Math.min(retryAfterMs * 2 ** (this.failures - 1), maxRetryAfterMs);
    const random = this.deps.random ?? Math.random;
    this.cancelTimer();
    this.timer = this.deps.timers.set(
      () => {
        this.timer = null;
        void this.flush();
      },
      wait * (1 + 0.25 * random()),
    );
  }

  private cancelTimer(): void {
    if (this.timer === null) return;
    this.deps.timers.clear(this.timer);
    this.timer = null;
  }
}
