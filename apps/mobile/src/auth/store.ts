import { type Me, meSchema } from '@outfitly/shared';
import { useSyncExternalStore } from 'react';
import { storage } from '../lib/storage';

const ME_KEY = 'auth.me';
const PENDING_MERGE_KEY = 'auth.pendingGuestMerge';

/** The signed-in login and its profiles, kept on the phone so the app opens instantly. */
let current: Me | null = read();
const listeners = new Set<() => void>();

function read(): Me | null {
  const raw = storage.getString(ME_KEY);
  if (!raw) return null;
  try {
    // An older app version may have stored another shape: ignore it.
    const parsed = meSchema.safeParse(JSON.parse(raw));
    return parsed.success ? parsed.data : null;
  } catch {
    return null;
  }
}

export function setMe(me: Me | null): void {
  current = me;
  if (me) storage.set(ME_KEY, JSON.stringify(me));
  else storage.remove(ME_KEY);
  for (const listener of listeners) listener();
}

export function getMe(): Me | null {
  return current;
}

/** The profile every request acts as (sent as X-Profile-Id). */
export function getActiveProfileId(): string | null {
  return current?.activeProfileId ?? null;
}

function subscribe(listener: () => void): () => void {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

export function useMe(): Me | null {
  return useSyncExternalStore(subscribe, getMe);
}

/** A guest token whose content still has to move into the signed-in account. */
export const pendingGuestMerge = {
  get: (): string | null => storage.getString(PENDING_MERGE_KEY) ?? null,
  set: (token: string | null): void => {
    if (token) storage.set(PENDING_MERGE_KEY, token);
    else storage.remove(PENDING_MERGE_KEY);
  },
};
