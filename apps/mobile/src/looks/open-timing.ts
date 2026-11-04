import { useSyncExternalStore } from 'react';

/**
 * How long opening a look takes: from the tap on a card to the look's photo
 * on screen. The developer menu shows the last one (the goal is under 400 ms
 * once the photo is cached).
 */
let startedAt: number | null = null;
let lastMs: number | null = null;
const listeners = new Set<() => void>();

/** A card was tapped. */
export function markLookOpening(): void {
  startedAt = performance.now();
}

/** The look page's photo is on screen. */
export function markLookShown(): void {
  if (startedAt === null) return;
  lastMs = Math.round(performance.now() - startedAt);
  startedAt = null;
  for (const listener of listeners) listener();
}

function subscribe(listener: () => void): () => void {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

export function useLastLookOpenMs(): number | null {
  return useSyncExternalStore(subscribe, () => lastMs);
}
