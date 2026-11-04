/** The look a save button showed, and whether it was saved. */
export interface ShownSave {
  lookId: string;
  saved: boolean;
}

/**
 * Whether the bookmark should bounce: the same look just became saved. Grid
 * cells are reused while scrolling, so a button may now show another look
 * that was saved already; that one stays still.
 */
export function justSaved(before: ShownSave, now: ShownSave): boolean {
  return now.saved && !before.saved && before.lookId === now.lookId;
}
