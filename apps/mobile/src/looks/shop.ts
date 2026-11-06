// Pure maths for "shop the look" (no React Native imports, so it's unit-tested).
import { type LookItem, type PiecesTotal, piecesTotal } from '@outfitly/shared';

/** No pieces: one shared empty list, so screens and lists don't see a "new" one every render. */
export const NO_ITEMS: readonly LookItem[] = [];

interface Size {
  width: number;
  height: number;
}

/**
 * Where a dot (in fractions of the photo) lands on screen when the photo
 * fills a `frame` of another shape, cropped evenly on both sides (expo-image's
 * `contentFit="cover"`, which the look page uses). A dot cropped off by at
 * most `tolerance` points is moved to the edge; further off, it's null.
 */
export function dotPlacement(
  photo: Size,
  frame: Size,
  dot: { x: number; y: number },
  tolerance = 0,
): { left: number; top: number } | null {
  const scale = Math.max(frame.width / photo.width, frame.height / photo.height);
  const drawnWidth = photo.width * scale;
  const drawnHeight = photo.height * scale;
  const left = (frame.width - drawnWidth) / 2 + dot.x * drawnWidth;
  const top = (frame.height - drawnHeight) / 2 + dot.y * drawnHeight;
  const outside = (value: number, size: number) => value < -tolerance || value > size + tolerance;
  if (outside(left, frame.width) || outside(top, frame.height)) return null;
  return { left: clamp(left, 0, frame.width), top: clamp(top, 0, frame.height) };
}

const clamp = (value: number, min: number, max: number) => Math.min(Math.max(value, min), max);

/**
 * A dot at `place` drawn `dotSize` wide with a `hitSize` square taking the
 * tap: both kept inside the frame (Android ignores taps outside a view's
 * parent), the dot as close to `place` as fits. `dot` is relative to `hit`.
 */
export function dotTarget(
  place: { left: number; top: number },
  frame: Size,
  dotSize: number,
  hitSize: number,
): { hit: { left: number; top: number }; dot: { left: number; top: number } } {
  const centre = {
    left: clamp(place.left, dotSize / 2, frame.width - dotSize / 2),
    top: clamp(place.top, dotSize / 2, frame.height - dotSize / 2),
  };
  const hit = {
    left: clamp(centre.left - hitSize / 2, 0, Math.max(0, frame.width - hitSize)),
    top: clamp(centre.top - hitSize / 2, 0, Math.max(0, frame.height - hitSize)),
  };
  return {
    hit,
    dot: { left: centre.left - dotSize / 2 - hit.left, top: centre.top - dotSize / 2 - hit.top },
  };
}

/** Dots to draw on photo `photo` of the look: the pieces that have a dot there. */
export function dotsOnPhoto(items: readonly LookItem[], photo: number) {
  return items.flatMap((item) =>
    item.dot?.photo === photo ? [{ item, x: item.dot.x, y: item.dot.y }] : [],
  );
}

const DAY_MS = 24 * 60 * 60 * 1000;

/**
 * Whole calendar days (in the phone's time zone) between `iso` and `now`:
 * 0 today, 1 yesterday. A time in the future counts as today.
 */
export function daysSince(iso: string, now: Date): number {
  const then = new Date(iso);
  const day = (d: Date) => Date.UTC(d.getFullYear(), d.getMonth(), d.getDate());
  return Math.max(0, Math.round((day(now) - day(then)) / DAY_MS));
}

/**
 * The locale prices are written in: the app's language with the phone's
 * region, so English on a Swedish phone still writes "1 299 kr".
 */
export function moneyLocale(language: string, regionCode: string | null | undefined): string {
  if (regionCode && /^[A-Z]{2}$/.test(regionCode)) return `${language}-${regionCode}`;
  return language === 'sv' ? 'sv-SE' : 'en-GB';
}

/** A sold-out piece can't be ticked, but one ticked before it sold out can be unticked. */
export function canTick(item: LookItem, ticked: ReadonlySet<string>): boolean {
  return item.stock !== 'out_of_stock' || ticked.has(item.id);
}

/**
 * The ticked pieces still on the look: how many, and what they cost (pieces
 * that sold out or lost their price since they were ticked are counted
 * apart, never added).
 */
export function selection(
  items: readonly LookItem[],
  ticked: ReadonlySet<string>,
): PiecesTotal & { count: number } {
  const total = piecesTotal(items, ticked);
  return { ...total, count: total.counted + total.soldOut + total.unpriced };
}
