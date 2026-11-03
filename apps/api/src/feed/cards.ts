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
  sql,
  type SQL,
} from '@outfitly/db';
import type { FeedCard } from '@outfitly/shared';
import type { z } from 'zod';
import { ApiError } from '../errors.ts';
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

/** Cards for these looks, by id. Looks that can't be shown any more are missing. */
export async function loadCards(
  { db, storage }: FeedDeps,
  ids: readonly string[],
): Promise<Map<string, FeedCard>> {
  const cards = new Map<string, FeedCard>();
  if (ids.length === 0) return cards;
  const rows = await db
    .select({
      id: looks.id,
      authorId: looks.authorProfileId,
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
  for (const { id, authorId, width, height, thumbhash, dominantColor, ...keys } of rows) {
    // A ready photo always has these (media_ready_is_complete); this satisfies the types.
    if (!width || !height || !thumbhash || !dominantColor) continue;
    if (!keys.key1080 || !keys.key600 || !keys.key300) continue;
    cards.set(id, {
      id,
      authorId,
      photo: {
        width,
        height,
        thumbhash,
        dominantColor,
        urls: {
          1080: storage.publicUrl(keys.key1080),
          600: storage.publicUrl(keys.key600),
          300: storage.publicUrl(keys.key300),
        },
      },
      itemCount: 0, // Shoppable pieces arrive with products (Phase 3).
    });
  }
  return cards;
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
