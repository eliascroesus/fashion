// Pure maths for "shop the look" (no React Native imports, so it's unit-tested).
import type { LookItem } from '@outfitly/shared';

interface Size {
  width: number;
  height: number;
}

/**
 * Where a dot (in fractions of the photo) lands on screen when the photo
 * fills a `frame` of another shape, cropped evenly on both sides (expo-image's
 * `contentFit="cover"`, which the look page uses). Null if that part of the
 * photo is cropped away.
 */
export function dotPlacement(
  photo: Size,
  frame: Size,
  dot: { x: number; y: number },
): { left: number; top: number } | null {
  const scale = Math.max(frame.width / photo.width, frame.height / photo.height);
  const drawnWidth = photo.width * scale;
  const drawnHeight = photo.height * scale;
  const left = (frame.width - drawnWidth) / 2 + dot.x * drawnWidth;
  const top = (frame.height - drawnHeight) / 2 + dot.y * drawnHeight;
  if (left < 0 || left > frame.width || top < 0 || top > frame.height) return null;
  return { left, top };
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
