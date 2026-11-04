import { useSyncExternalStore } from 'react';
import { storage } from '../lib/storage';
import { readRecent, withRecent } from './logic';

const RECENT_KEY = 'search.recent';

let recent = readRecent(storage.getString(RECENT_KEY));
const listeners = new Set<() => void>();

function subscribe(listener: () => void): () => void {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

function setRecent(next: string[]): void {
  recent = next;
  if (next.length === 0) storage.remove(RECENT_KEY);
  else storage.set(RECENT_KEY, JSON.stringify(next));
  for (const listener of listeners) listener();
}

/** The last searches on this phone, newest first. */
export function useRecentSearches(): readonly string[] {
  return useSyncExternalStore(subscribe, () => recent);
}

export function addRecentSearch(text: string): void {
  setRecent(withRecent(recent, text));
}

export function removeRecentSearch(text: string): void {
  setRecent(recent.filter((s) => s !== text));
}

/** "Clear", and sign-out (searches belong to whoever was signed in). */
export function clearRecentSearches(): void {
  setRecent([]);
}

/**
 * How long suggestions take: from a keystroke to the suggestions for that
 * text on screen (the goal is under 300 ms). The developer menu shows the last.
 */
let typed: { text: string; at: number } | null = null;
let lastSuggestMs: number | null = null;

export function markTyped(text: string): void {
  typed = { text, at: performance.now() };
}

/** Suggestions for `text` are on screen; counts only if nothing was typed since. */
export function markSuggestionsShown(text: string): void {
  if (typed?.text !== text) return;
  lastSuggestMs = Math.round(performance.now() - typed.at);
  typed = null;
  for (const listener of listeners) listener();
}

export function useLastSuggestMs(): number | null {
  return useSyncExternalStore(subscribe, () => lastSuggestMs);
}
