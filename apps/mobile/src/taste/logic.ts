// The taste picker's plain logic (no React Native imports, so it's unit-tested).
import { knownStyles, type Style, STYLES } from '@outfitly/shared';

/** Style chips ticked for you after the swipes: the styles of the looks you liked, most first. */
export const PRESELECTED_STYLES = 3;

export function preselectStyles(
  liked: readonly { styles: readonly string[] }[],
  max: number = PRESELECTED_STYLES,
): Style[] {
  const counts = new Map<Style, number>();
  for (const look of liked) {
    for (const style of knownStyles(look.styles)) counts.set(style, (counts.get(style) ?? 0) + 1);
  }
  // Ties keep the list order (STYLES), so the same likes always tick the same chips.
  return STYLES.filter((style) => counts.has(style))
    .sort((a, b) => (counts.get(b) ?? 0) - (counts.get(a) ?? 0))
    .slice(0, max);
}

/** Adds the value if it's missing, removes it if it's there (a chip tap). */
export function toggle<T>(values: readonly T[], value: T): T[] {
  return values.includes(value) ? values.filter((v) => v !== value) : [...values, value];
}
