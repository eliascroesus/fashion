import { type Db, sql, type SQL } from '@outfitly/db';
import {
  BOARD_COVERS,
  type Board,
  FEED_PAGE_SIZE,
  type FeedPage,
  MAX_BOARDS_PER_PROFILE,
  MAX_LOOK_ITEMS,
} from '@outfitly/shared';
import { z } from 'zod';
import { ApiError } from './errors.ts';
import {
  decodeCursor,
  encodeCursor,
  type FeedDeps,
  loadCards,
  microsText,
  microsTime,
  showableLook,
} from './feed/cards.ts';
import { SHOWN_ITEM, SHOWN_ITEM_JOINS } from './shown-items.ts';

/*
 * Saves, boards and "see less like this", always as the acting profile.
 * Every write sets a state ("saved", "on this board"), so doing it twice
 * changes nothing; one row per pair, soft-deleted and revived.
 *
 * Rules: a look on a board is always saved too (adding it saves it), and
 * unsaving a look takes it off the profile's boards. Deleting a board leaves
 * its looks saved.
 */

type Tx = Parameters<Parameters<Db['transaction']>[0]>[0];

const notFound = (what: string) => new ApiError(404, 'not_found', `${what} not found.`);

/** Throws 404 unless the look can be shown in feeds (published, author and photo there). */
async function requireShowableLook(db: Db | Tx, lookId: string): Promise<void> {
  const { rows } = await db.execute(
    sql`SELECT 1 FROM looks l WHERE l.id = ${lookId} AND ${showableLook(sql`l`)}`,
  );
  if (rows.length === 0) throw notFound('Look');
}

/** Throws 404 unless the board belongs to the profile and isn't deleted. */
async function requireOwnBoard(db: Db | Tx, profileId: string, boardId: string): Promise<void> {
  const { rows } = await db.execute(sql`
    SELECT 1 FROM boards
     WHERE id = ${boardId} AND profile_id = ${profileId} AND deleted_at IS NULL`);
  if (rows.length === 0) throw notFound('Board');
}

/** Saves the look (or brings back an undone save). An existing save is left as it is. */
async function upsertSave(db: Db | Tx, profileId: string, lookId: string): Promise<void> {
  await db.execute(sql`
    INSERT INTO saves (profile_id, look_id) VALUES (${profileId}, ${lookId})
    ON CONFLICT (profile_id, look_id)
      DO UPDATE SET deleted_at = NULL, updated_at = now() WHERE saves.deleted_at IS NOT NULL`);
}

export async function saveLook(db: Db, profileId: string, lookId: string): Promise<void> {
  await requireShowableLook(db, lookId);
  await upsertSave(db, profileId, lookId);
}

/** Unsaves the look and takes it off the profile's boards. Works for looks hidden since. */
export async function unsaveLook(db: Db, profileId: string, lookId: string): Promise<void> {
  await db.transaction(async (tx) => {
    await tx.execute(sql`
      UPDATE saves SET deleted_at = now(), updated_at = now()
       WHERE profile_id = ${profileId} AND look_id = ${lookId} AND deleted_at IS NULL`);
    await tx.execute(sql`
      UPDATE board_items bi SET deleted_at = now(), updated_at = now()
        FROM boards b
       WHERE b.id = bi.board_id AND b.profile_id = ${profileId}
         AND bi.look_id = ${lookId} AND bi.deleted_at IS NULL`);
  });
}

/** Puts the look on the board (and saves it). The board moves to the top of the list. */
export async function addToBoard(
  db: Db,
  profileId: string,
  boardId: string,
  lookId: string,
): Promise<void> {
  await db.transaction(async (tx) => {
    await requireOwnBoard(tx, profileId, boardId);
    await requireShowableLook(tx, lookId);
    const { rows } = await tx.execute(sql`
      INSERT INTO board_items (board_id, look_id) VALUES (${boardId}, ${lookId})
      ON CONFLICT (board_id, look_id)
        DO UPDATE SET deleted_at = NULL, updated_at = now() WHERE board_items.deleted_at IS NOT NULL
      RETURNING 1`);
    await upsertSave(tx, profileId, lookId);
    if (rows.length > 0) {
      await tx.execute(sql`UPDATE boards SET updated_at = now() WHERE id = ${boardId}`);
    }
  });
}

/** Takes the look off the board; it stays saved. */
export async function removeFromBoard(
  db: Db,
  profileId: string,
  boardId: string,
  lookId: string,
): Promise<void> {
  await requireOwnBoard(db, profileId, boardId);
  await db.execute(sql`
    UPDATE board_items SET deleted_at = now(), updated_at = now()
     WHERE board_id = ${boardId} AND look_id = ${lookId} AND deleted_at IS NULL`);
}

/** "See less like this": the look leaves For You and similar ones move back (see demoteSimilar). */
export async function seeLess(db: Db, profileId: string, lookId: string): Promise<void> {
  await requireShowableLook(db, lookId);
  await db.execute(sql`
    INSERT INTO swipes (profile_id, look_id, kind) VALUES (${profileId}, ${lookId}, 'see_less')
    ON CONFLICT (profile_id, look_id) DO UPDATE SET kind = EXCLUDED.kind, updated_at = now()`);
}

interface BoardRow extends Record<string, unknown> {
  id: string;
  name: string;
  look_count: number;
  cover_ids: string[];
  has_look: boolean | null;
  /** Sums as text (bigint), one per currency; null when not asked for. */
  totals: { currency: string; amount: string }[] | null;
}

/**
 * What board `b`'s pieces cost together, one sum per currency (most pieces
 * first): the pieces its shown looks show (each look's first MAX_LOOK_ITEMS,
 * like the look page), each product once even if several looks (or shop
 * links) have it, at its lowest price on the board in that currency;
 * sold-out and unpriced pieces left out (the look page's rule).
 */
const BOARD_TOTALS = sql`
  SELECT coalesce(json_agg(json_build_object('currency', t.currency, 'amount', t.amount::text)
                           ORDER BY t.pieces DESC, t.currency), '[]'::json)
    FROM (SELECT d.currency, sum(d.price_minor) AS amount, count(*) AS pieces
            FROM (SELECT DISTINCT ON (s.product_id, s.currency) s.currency, s.price_minor
                    FROM board_items bi JOIN looks l ON l.id = bi.look_id
                    CROSS JOIN LATERAL (
                      SELECT o.product_id, o.currency, o.price_minor, o.stock
                        FROM look_items li ${SHOWN_ITEM_JOINS}
                       WHERE li.look_id = l.id AND ${SHOWN_ITEM}
                       ORDER BY li.created_at, li.id
                       LIMIT ${MAX_LOOK_ITEMS}) s
                   WHERE bi.board_id = b.id AND bi.deleted_at IS NULL
                     AND ${showableLook(sql`l`)} AND l.published_at <= now()
                     AND s.price_minor > 0 AND s.stock <> 'out_of_stock'
                   ORDER BY s.product_id, s.currency, s.price_minor) d
           GROUP BY d.currency) t`;

/** Looks on board `b` that can be shown (`b` is the boards alias in the surrounding query). */
function shownItems(select: SQL): SQL {
  return sql`SELECT ${select} FROM board_items bi JOIN looks l ON l.id = bi.look_id
              WHERE bi.board_id = b.id AND bi.deleted_at IS NULL AND ${showableLook(sql`l`)}`;
}

/**
 * The profile's boards, most recently changed first, with how many looks
 * each holds, its newest looks' photos and what its pieces cost. With
 * `lookId` (the "Save to board" sheet), whether each holds that look instead
 * of the cost; with `boardId`, only that board.
 */
async function loadBoards(
  deps: FeedDeps,
  profileId: string,
  { lookId, boardId }: { lookId?: string | undefined; boardId?: string } = {},
): Promise<Board[]> {
  const { rows } = await deps.db.execute<BoardRow>(sql`
    SELECT b.id, b.name,
           (${shownItems(sql`count(*)::int`)}) AS look_count,
           ARRAY(${shownItems(sql`bi.look_id`)}
                 ORDER BY bi.updated_at DESC, bi.id DESC LIMIT ${BOARD_COVERS}) AS cover_ids,
           ${lookId ? sql`NULL::json` : sql`(${BOARD_TOTALS})`} AS totals,
           ${
             lookId
               ? sql`EXISTS (SELECT 1 FROM board_items i WHERE i.board_id = b.id
                               AND i.look_id = ${lookId} AND i.deleted_at IS NULL)`
               : sql`NULL::boolean`
           } AS has_look
      FROM boards b
     WHERE b.profile_id = ${profileId} AND b.deleted_at IS NULL
       ${boardId ? sql`AND b.id = ${boardId}` : sql``}
     ORDER BY b.updated_at DESC, b.id DESC
     LIMIT ${MAX_BOARDS_PER_PROFILE}`);
  // Only their photos are used: no piece counts.
  const cards = await loadCards(
    deps,
    rows.flatMap((r) => r.cover_ids),
    profileId,
    { countItems: false },
  );
  return rows.map((r) => ({
    id: r.id,
    name: r.name,
    lookCount: r.look_count,
    covers: r.cover_ids.flatMap((id) => cards.get(id)?.photo ?? []),
    ...(r.totals === null
      ? {}
      : { totals: r.totals.map((t) => ({ currency: t.currency, amountMinor: Number(t.amount) })) }),
    ...(r.has_look === null ? {} : { hasLook: r.has_look }),
  }));
}

export function listBoards(deps: FeedDeps, profileId: string, lookId?: string): Promise<Board[]> {
  return loadBoards(deps, profileId, { lookId });
}

async function loadBoard(deps: FeedDeps, profileId: string, boardId: string): Promise<Board> {
  const [board] = await loadBoards(deps, profileId, { boardId });
  if (!board) throw notFound('Board');
  return board;
}

/** A new, empty board. A profile has at most MAX_BOARDS_PER_PROFILE. */
export async function createBoard(deps: FeedDeps, profileId: string, name: string): Promise<Board> {
  const id = await deps.db.transaction(async (tx) => {
    // One create per profile at a time, so two at once can't pass the limit.
    await tx.execute(sql`SELECT pg_advisory_xact_lock(hashtext('boards'), hashtext(${profileId}))`);
    const { rows } = await tx.execute<{ count: number }>(sql`
      SELECT count(*)::int AS count FROM boards
       WHERE profile_id = ${profileId} AND deleted_at IS NULL`);
    if ((rows[0]?.count ?? 0) >= MAX_BOARDS_PER_PROFILE) {
      throw new ApiError(
        409,
        'conflict',
        `You can have up to ${String(MAX_BOARDS_PER_PROFILE)} boards.`,
      );
    }
    const inserted = await tx.execute<{ id: string }>(sql`
      INSERT INTO boards (profile_id, name) VALUES (${profileId}, ${name}) RETURNING id`);
    const row = inserted.rows[0];
    if (!row) throw new Error('Board insert returned no row.');
    return row.id;
  });
  return loadBoard(deps, profileId, id);
}

export async function renameBoard(
  deps: FeedDeps,
  profileId: string,
  boardId: string,
  name: string,
): Promise<Board> {
  const { rows } = await deps.db.execute(sql`
    UPDATE boards SET name = ${name}, updated_at = now()
     WHERE id = ${boardId} AND profile_id = ${profileId} AND deleted_at IS NULL
    RETURNING 1`);
  if (rows.length === 0) throw notFound('Board');
  return loadBoard(deps, profileId, boardId);
}

/** Deletes the board; its looks stay saved. Deleting it again is a 404. */
export async function deleteBoard(db: Db, profileId: string, boardId: string): Promise<void> {
  const { rows } = await db.execute(sql`
    UPDATE boards SET deleted_at = now(), updated_at = now()
     WHERE id = ${boardId} AND profile_id = ${profileId} AND deleted_at IS NULL
    RETURNING 1`);
  if (rows.length === 0) throw notFound('Board');
}

/** The last row of the previous page. `t` keeps Postgres's microseconds. */
const listCursorSchema = z.object({ t: microsTime, id: z.uuid() });
type ListCursor = z.infer<typeof listCursorSchema>;

interface ListRow extends Record<string, unknown> {
  row_id: string;
  look_id: string;
  t: string;
}

/** `AND (time, id) < cursor` for a keyset page (nothing on the first page). */
type Keyset = (time: SQL, id: SQL) => SQL;

/**
 * One page of a saved list, newest first. `rowsAfter(keyset)` returns up to
 * FEED_PAGE_SIZE + 1 rows (row id, look id, time) after the cursor.
 */
async function listPage(
  deps: FeedDeps,
  profileId: string,
  cursor: string | undefined,
  rowsAfter: (keyset: Keyset) => SQL,
): Promise<FeedPage> {
  const after: ListCursor | undefined =
    cursor === undefined ? undefined : decodeCursor(listCursorSchema, cursor);
  const keyset: Keyset = (time, id) =>
    after ? sql`AND (${time}, ${id}) < (${after.t}::timestamptz, ${after.id}::uuid)` : sql``;
  const { rows } = await deps.db.execute<ListRow>(rowsAfter(keyset));
  const page = rows.slice(0, FEED_PAGE_SIZE);
  const cards = await loadCards(
    deps,
    page.map((r) => r.look_id),
    profileId,
  );
  const last = page.at(-1);
  return {
    // A look hidden between the two queries is left out of this page.
    items: page.flatMap((r) => cards.get(r.look_id) ?? []),
    nextCursor:
      rows.length > FEED_PAGE_SIZE && last ? encodeCursor({ t: last.t, id: last.row_id }) : null,
  };
}

/** Everything the profile saved, most recently saved first. */
export function savesPage(
  deps: FeedDeps,
  profileId: string,
  cursor: string | undefined,
): Promise<FeedPage> {
  return listPage(
    deps,
    profileId,
    cursor,
    (keyset) => sql`
      SELECT s.id AS row_id, s.look_id, ${microsText(sql`s.updated_at`)} AS t
        FROM saves s JOIN looks l ON l.id = s.look_id
       WHERE s.profile_id = ${profileId} AND s.deleted_at IS NULL AND ${showableLook(sql`l`)}
         ${keyset(sql`s.updated_at`, sql`s.id`)}
       ORDER BY s.updated_at DESC, s.id DESC
       LIMIT ${FEED_PAGE_SIZE + 1}`,
  );
}

/** A board's looks, most recently added first. */
export async function boardLooksPage(
  deps: FeedDeps,
  profileId: string,
  boardId: string,
  cursor: string | undefined,
): Promise<FeedPage> {
  await requireOwnBoard(deps.db, profileId, boardId);
  return listPage(
    deps,
    profileId,
    cursor,
    (keyset) => sql`
      SELECT bi.id AS row_id, bi.look_id, ${microsText(sql`bi.updated_at`)} AS t
        FROM board_items bi JOIN looks l ON l.id = bi.look_id
       WHERE bi.board_id = ${boardId} AND bi.deleted_at IS NULL AND ${showableLook(sql`l`)}
         ${keyset(sql`bi.updated_at`, sql`bi.id`)}
       ORDER BY bi.updated_at DESC, bi.id DESC
       LIMIT ${FEED_PAGE_SIZE + 1}`,
  );
}
