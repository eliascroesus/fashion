import type { Me } from '@outfitly/shared';
import { useSyncExternalStore } from 'react';
import { storage } from '../lib/storage';

const KEY = 'auth.me';

/** The signed-in login and its profiles, kept on the phone so the app opens instantly. */
let current: Me | null = read();
const listeners = new Set<() => void>();

function read(): Me | null {
  const raw = storage.getString(KEY);
  if (!raw) return null;
  try {
    return JSON.parse(raw) as Me;
  } catch {
    return null;
  }
}

export function setMe(me: Me | null): void {
  current = me;
  if (me) storage.set(KEY, JSON.stringify(me));
  else storage.remove(KEY);
  for (const listener of listeners) listener();
}

export function getMe(): Me | null {
  return current;
}

/** The profile every request acts as (sent as X-Profile-Id). */
export function getActiveProfileId(): string | null {
  return current?.activeProfileId ?? null;
}

export function useMe(): Me | null {
  return useSyncExternalStore(
    (listener) => {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
    () => current,
  );
}
