import { useSyncExternalStore } from 'react';
import { storage } from './storage';

/** Developer tools (pretend offline, password sign-in) are in every build except the store one. */
export const DEV_TOOLS = process.env['EXPO_PUBLIC_APP_ENV'] !== 'production';

const MENU_KEY = 'dev.menu';
const OFFLINE_KEY = 'dev.offline';

const listeners = new Set<() => void>();

function subscribe(listener: () => void): () => void {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

function set(key: string, on: boolean): void {
  storage.set(key, on);
  for (const listener of listeners) listener();
}

/** The hidden developer menu (long-press the Profile title). */
export function isDevMenuOn(): boolean {
  return storage.getBoolean(MENU_KEY) ?? false;
}

export function setDevMenu(on: boolean): void {
  set(MENU_KEY, on);
}

export function useDevMenu(): boolean {
  return useSyncExternalStore(subscribe, isDevMenuOn);
}

/** "Pretend offline": every API request fails the way it does in airplane mode. */
export function isPretendOffline(): boolean {
  return DEV_TOOLS && (storage.getBoolean(OFFLINE_KEY) ?? false);
}

export function setPretendOffline(on: boolean): void {
  set(OFFLINE_KEY, on);
}

export function usePretendOffline(): boolean {
  return useSyncExternalStore(subscribe, isPretendOffline);
}
