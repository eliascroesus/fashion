// Decides when a feed card counts as seen. Pure (timers are passed in), so it's unit-tested.
import { realTimers, type Timers } from '../lib/timers';

/** A card counts once it has been at least half on screen for this long without a break. */
export const IMPRESSION_MS = 1000;

export interface VisibleCard {
  lookId: string;
  /** 0-based place in the feed. */
  position: number;
}

/**
 * Feed it the cards that are at least half visible (the list's viewability
 * callback); it calls `onImpression` once per card per list, after the card
 * stayed visible for IMPRESSION_MS. Paused while the feed isn't on screen
 * (another tab or screen, app in the background): pausing restarts the clock.
 */
export class ImpressionTracker {
  private readonly visible = new Map<string, { position: number; timer: unknown }>();
  private readonly counted = new Set<string>();
  private active = true;

  constructor(
    private readonly onImpression: (card: VisibleCard) => void,
    private readonly timers: Timers = realTimers,
    private readonly minMs: number = IMPRESSION_MS,
  ) {}

  /** The cards now at least half on screen. */
  update(cards: readonly VisibleCard[]): void {
    const now = new Map(cards.map((c) => [c.lookId, c.position]));
    for (const [lookId, entry] of this.visible) {
      if (!now.has(lookId)) {
        this.stop(entry);
        this.visible.delete(lookId);
      }
    }
    for (const [lookId, position] of now) {
      const entry = this.visible.get(lookId);
      if (entry) {
        entry.position = position;
      } else {
        this.visible.set(lookId, { position, timer: null });
        this.start(lookId);
      }
    }
  }

  setActive(active: boolean): void {
    if (active === this.active) return;
    this.active = active;
    for (const [lookId, entry] of this.visible) {
      if (active) this.start(lookId);
      else this.stop(entry);
    }
  }

  /** A new list (pull to refresh): every card may count again. */
  reset(): void {
    for (const entry of this.visible.values()) this.stop(entry);
    this.visible.clear();
    this.counted.clear();
  }

  dispose(): void {
    for (const entry of this.visible.values()) this.stop(entry);
  }

  private start(lookId: string): void {
    const entry = this.visible.get(lookId);
    if (!entry || !this.active || this.counted.has(lookId) || entry.timer !== null) return;
    entry.timer = this.timers.set(() => {
      entry.timer = null;
      if (!this.active || this.visible.get(lookId) !== entry || this.counted.has(lookId)) return;
      this.counted.add(lookId);
      this.onImpression({ lookId, position: entry.position });
    }, this.minMs);
  }

  private stop(entry: { timer: unknown }): void {
    if (entry.timer === null) return;
    this.timers.clear(entry.timer);
    entry.timer = null;
  }
}
