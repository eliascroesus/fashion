import { type Db, eq, settings } from '@outfitly/db';
import type { z } from 'zod';

/** How long a setting read from the database is reused (a change applies within this). */
const CACHE_MS = 60_000;

const cache = new Map<string, { value: unknown; until: number }>();

/** A setting is missing or its value has the wrong shape: a deploy or migration problem. */
export class SettingError extends Error {
  constructor(key: string, problem: string) {
    super(`Setting "${key}" ${problem}.`);
    this.name = 'SettingError';
  }
}

/**
 * One row of `settings`, checked with `schema` and cached for a minute. There
 * are no defaults in code: the migration that needs a setting inserts it.
 * Throws `SettingError`.
 */
export async function readSetting<T>(db: Db, key: string, schema: z.ZodType<T>): Promise<T> {
  const hit = cache.get(key);
  if (hit && hit.until > Date.now()) return hit.value as T;
  const [row] = await db
    .select({ value: settings.value })
    .from(settings)
    .where(eq(settings.key, key));
  if (!row) throw new SettingError(key, 'is missing');
  const parsed = schema.safeParse(row.value);
  if (!parsed.success) throw new SettingError(key, `has a wrong value (${parsed.error.message})`);
  cache.set(key, { value: parsed.data, until: Date.now() + CACHE_MS });
  return parsed.data;
}

/** Tests (and scripts that just changed a setting) read it fresh. */
export function forgetCachedSettings(): void {
  cache.clear();
}
