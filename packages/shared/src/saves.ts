import { z } from 'zod';
import { feedCardSchema } from './feed.ts';
import { moneySchema } from './money.ts';

/** A profile can have at most this many boards. */
export const MAX_BOARDS_PER_PROFILE = 200;
export const BOARD_NAME_MAX = 50;
/** Covers shown on a board tile: its newest looks' photos. */
export const BOARD_COVERS = 3;

/** `PUT` / `DELETE /v1/saves/:lookId`: whether the look is saved now. */
export const saveStateSchema = z.object({ lookId: z.uuid(), saved: z.boolean() });
export type SaveState = z.infer<typeof saveStateSchema>;

/** `PUT` / `DELETE /v1/boards/:boardId/looks/:lookId`. */
export const boardItemStateSchema = z.object({
  boardId: z.uuid(),
  lookId: z.uuid(),
  inBoard: z.boolean(),
});
export type BoardItemState = z.infer<typeof boardItemStateSchema>;

/**
 * A board name: spaces trimmed and runs of them collapsed, 1–50 characters,
 * no control characters (line breaks included).
 */
export const boardNameSchema = z
  .string()
  .transform((name) => name.trim().replace(/\s+/g, ' '))
  .pipe(
    z
      .string()
      .min(1)
      .max(BOARD_NAME_MAX)
      // eslint-disable-next-line no-control-regex
      .regex(/^[^\u0000-\u001f\u007f]*$/, 'No control characters.'),
  );

/** `POST /v1/boards` and `PATCH /v1/boards/:boardId`. */
export const boardBodySchema = z.object({ name: boardNameSchema });
export type BoardBody = z.input<typeof boardBodySchema>;

export const boardSchema = z.object({
  id: z.uuid(),
  name: z.string(),
  /** Looks on the board that can still be shown. */
  lookCount: z.number().int().nonnegative(),
  /** The newest looks' cover photos, newest first (up to BOARD_COVERS). */
  covers: z.array(feedCardSchema.shape.photo).max(BOARD_COVERS),
  /**
   * What the board's pieces cost together, one total per currency (no
   * exchange rates): each shop link once, even if it's in several of the
   * board's looks; sold-out and unpriced pieces left out. Empty when none.
   */
  totals: z.array(moneySchema),
  /** Only with `?lookId=`: whether that look is on this board. */
  hasLook: z.boolean().optional(),
});
export type Board = z.infer<typeof boardSchema>;

/** `GET /v1/boards`: every board, most recently changed first (at most MAX_BOARDS_PER_PROFILE). */
export const boardListSchema = z.object({ items: z.array(boardSchema) });
export type BoardList = z.infer<typeof boardListSchema>;

/** `GET /v1/boards?lookId=` also says which boards hold that look. */
export const boardListQuerySchema = z.object({ lookId: z.uuid().optional() });

/** "See less like this" (`PUT /v1/swipes/:lookId`). "skip" comes with swipe mode (Phase 6). */
export const swipeBodySchema = z.object({ kind: z.literal('see_less') });
export type SwipeBody = z.infer<typeof swipeBodySchema>;
export const swipeStateSchema = z.object({ lookId: z.uuid(), kind: z.literal('see_less') });

/** `DELETE /v1/boards/:boardId`. */
export const boardDeletedSchema = z.object({ id: z.uuid(), deleted: z.literal(true) });
