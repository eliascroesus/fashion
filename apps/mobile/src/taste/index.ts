import { BRAND_IDS, type BrandId, knownStyles, type Style } from '@outfitly/shared';
import { useSyncExternalStore } from 'react';
import { FEED_QUERY_ROOT } from '../feed/keys';
import { queryClient } from '../lib/query';
import { storage } from '../lib/storage';
import { outbox } from '../saves';

/** What was picked, kept on the phone (For You sends the styles) and uploaded once there's a profile. */
const ANSWERS_KEY = 'taste.answers';
/** The picker was finished or skipped: it shows only at the first open. */
const DONE_KEY = 'taste.pickerDone';
/** How long the last run took (developer menu). */
const TIME_KEY = 'taste.pickerMs';

export interface TasteAnswers {
  styles: Style[];
  brands: BrandId[];
}

const listeners = new Set<() => void>();

function subscribe(listener: () => void): () => void {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

function changed(): void {
  for (const listener of listeners) listener();
}

function readAnswers(): TasteAnswers {
  try {
    const stored = JSON.parse(storage.getString(ANSWERS_KEY) ?? '{}') as {
      styles?: unknown;
      brands?: unknown;
    };
    const strings = (value: unknown) =>
      Array.isArray(value) ? value.filter((v): v is string => typeof v === 'string') : [];
    return {
      styles: knownStyles(strings(stored.styles)),
      brands: BRAND_IDS.filter((brand) => strings(stored.brands).includes(brand)),
    };
  } catch {
    return { styles: [], brands: [] };
  }
}

/** The styles picked on this phone (For You sends them; a profile's stored taste wins). */
export function getTasteStyles(): Style[] {
  return readAnswers().styles;
}

export function isPickerDone(): boolean {
  return storage.getBoolean(DONE_KEY) ?? false;
}

export function usePickerDone(): boolean {
  return useSyncExternalStore(subscribe, isPickerDone);
}

/** Milliseconds the last picker run took, or undefined before the first. */
export function usePickerTime(): number | undefined {
  return useSyncExternalStore(subscribe, () => storage.getNumber(TIME_KEY));
}

/**
 * The picker is done (`answers`) or skipped (null). Answers stay on the phone
 * and wait in the outbox until there's a profile (it never makes one). The next
 * For You list is made with them, never one made before.
 */
export function finishPicker(answers: TasteAnswers | null, ms: number): void {
  if (answers && (answers.styles.length > 0 || answers.brands.length > 0)) {
    storage.set(ANSWERS_KEY, JSON.stringify(answers));
    outbox.add({ kind: 'taste', styles: [...answers.styles], brands: [...answers.brands] });
  }
  storage.set(TIME_KEY, Math.round(ms));
  queryClient.removeQueries({ queryKey: [FEED_QUERY_ROOT, 'for-you'] });
  storage.set(DONE_KEY, true);
  changed();
}

/** Developer menu: show the picker again (as at a first open). */
export function showPickerAgain(): void {
  storage.set(DONE_KEY, false);
  changed();
}

/** Sign-out: the picks belong to that login now; the picker isn't shown again. */
export function forgetTaste(): void {
  storage.remove(ANSWERS_KEY);
  changed();
}
