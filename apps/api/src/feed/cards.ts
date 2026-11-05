import {
  and,
  type Db,
  eq,
  inArray,
  isNull,
  lookMedia,
  looks,
  media,
  profiles,
  saves,
  sql,
  type SQL,
} from '@outfitly/db';
import type { FeedCard } from '@outfitly/shared';
import { z } from 'zod';
import { ApiError } from '../errors.ts';
import { itemCountOf } from '../shown-items.ts';
import type { PhotoStorage } from '../storage.ts';

export interface FeedDeps {
  db: Db;
  storage: PhotoStorage;
}

/**
 * A look that may appear in any feed: published, its author still exists and
 * its cover photo (position 0) is ready. `look` is the looks table's alias in
 * the surrounding raw SQL. `loadCards` applies the same rules with joins.
 *
 * The author and photo checks are scalar subqueries on purpose: Postgres
 * checks them look by look while it walks a feed index in order and stops at
 * the LIMIT. Written as EXISTS, it turns them into joins and then reads and
 * sorts every published look (For You candidates on 10,000 looks: 91 ms → 13 ms).
 */
export function showableLook(look: SQL): SQL {
  return sql`${look}.status = 'published' AND ${look}.deleted_at IS NULL
    AND (SELECT a.deleted_at IS NULL FROM profiles a WHERE a.id = ${look}.author_profile_id)
    AND (SELECT m.status = 'ready' AND m.deleted_at IS NULL
           FROM look_media lm JOIN media m ON m.id = lm.media_id
          WHERE lm.look_id = ${look}.id AND lm.position = 0)`;
}

/** A photo's columns as stored (nullable until it's ready). */
export interface PhotoColumns {
  width: number | null;
  height: number | null;
  thumbhash: string | null;
  dominantColor: string | null;
  key1080: string | null;
  key600: string | null;
  key300: string | null;
}

/** A photo's columns as raw SQL returns them (`m.width, m.height, …, m.key_300`). */
export interface PhotoRow extends Record<string, unknown> {
  width: number | null;
  height: number | null;
  thumbhash: string | null;
  dominant_color: string | null;
  key_1080: string | null;
  key_600: string | null;
  key_300: string | null;
}

export const photoColumns = (row: PhotoRow): PhotoColumns => ({
  width: row.width,
  height: row.height,
  thumbhash: row.thumbhash,
  dominantColor: row.dominant_color,
  key1080: row.key_1080,
  key600: row.key_600,
  key300: row.key_300,
});

/** The public photo (sizes and links) of a ready photo; null if it isn't complete. */
export function toPhoto(storage: PhotoStorage, columns: PhotoColumns): FeedCard['photo'] | null {
  const { width, height, thumbhash, dominantColor, key1080, key600, key300 } = columns;
  // A ready photo always has these (media_ready_is_complete); this satisfies the types.
  if (!width || !height || !thumbhash || !dominantColor) return null;
  if (!key1080 || !key600 || !key300) return null;
  return {
    width,
    height,
    thumbhash,
    dominantColor,
    urls: {
      1080: storage.publicUrl(key1080),
      600: storage.publicUrl(key600),
      300: storage.publicUrl(key300),
    },
  };
}

/** Which of these looks the profile has saved (none when logged out). */
async function savedAmong(
  db: Db,
  viewerProfileId: string | null,
  ids: readonly string[],
): Promise<Set<string>> {
  if (viewerProfileId === null) return new Set();
  const rows = await db
    .select({ lookId: saves.lookId })
    .from(saves)
    .where(
      and(
        eq(saves.profileId, viewerProfileId),
        inArray(saves.lookId, [...ids]),
        isNull(saves.deletedAt),
      ),
    );
  return new Set(rows.map((r) => r.lookId));
}

/**
 * Cards for these looks, by id, as `viewerProfileId` sees them (null when
 * logged out). Looks that can't be shown any more are missing. Without
 * `countItems` their piece counts are 0 (for callers that only use photos).
 */
export async function loadCards(
  { db, storage }: FeedDeps,
  ids: readonly string[],
  viewerProfileId: string | null,
  { countItems = true }: { countItems?: boolean } = {},
): Promise<Map<string, FeedCard>> {
  const cards = new Map<string, FeedCard>();
  if (ids.length === 0) return cards;
  const rowsQuery = db
    .select({
      id: looks.id,
      authorId: looks.authorProfileId,
      itemCount: countItems ? itemCountOf(sql`${looks.id}`) : sql<number>`0`,
      width: media.width,
      height: media.height,
      thumbhash: media.thumbhash,
      dominantColor: media.dominantColor,
      key1080: media.key1080,
      key600: media.key600,
      key300: media.key300,
    })
    .from(looks)
    .innerJoin(profiles, and(eq(profiles.id, looks.authorProfileId), isNull(profiles.deletedAt)))
    .innerJoin(lookMedia, and(eq(lookMedia.lookId, looks.id), eq(lookMedia.position, 0)))
    .innerJoin(
      media,
      and(eq(media.id, lookMedia.mediaId), eq(media.status, 'ready'), isNull(media.deletedAt)),
    )
    .where(
      and(inArray(looks.id, [...ids]), eq(looks.status, 'published'), isNull(looks.deletedAt)),
    );
  const [rows, saved] = await Promise.all([rowsQuery, savedAmong(db, viewerProfileId, ids)]);
  for (const { id, authorId, itemCount, ...columns } of rows) {
    const photo = toPhoto(storage, columns);
    if (!photo) continue;
    cards.set(id, { id, authorId, photo, itemCount, saved: saved.has(id) });
  }
  return cards;
}

/**
 * A real UTC time with microseconds, e.g. 2026-11-03T10:00:00.123456Z, that
 * Postgres accepts (no Feb 30: it wouldn't round-trip; no year 0).
 */
export const microsTime = z
  .string()
  .regex(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{6}Z$/)
  .refine((t) => {
    const millis = t.slice(0, 23);
    const date = new Date(`${millis}Z`);
    return (
      !Number.isNaN(date.getTime()) &&
      date.toISOString().startsWith(millis) &&
      date.getUTCFullYear() >= 2000
    );
  });

/** Postgres timestamp as `microsTime` text, for keyset cursors. */
export function microsText(column: SQL): SQL<string> {
  return sql<string>`to_char(${column} AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.US"Z"')`;
}

/** Cursors are opaque to the app: base64url JSON, checked on the way back in. */
export function encodeCursor(value: object): string {
  return Buffer.from(JSON.stringify(value)).toString('base64url');
}

export function decodeCursor<T extends z.ZodType>(schema: T, cursor: string): z.output<T> {
  let value: unknown;
  try {
    value = JSON.parse(Buffer.from(cursor, 'base64url').toString('utf8'));
  } catch {
    value = undefined;
  }
  const parsed = schema.safeParse(value);
  if (!parsed.success) throw new ApiError(400, 'validation_failed', 'Invalid cursor.');
  return parsed.data;
}
