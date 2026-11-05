import type { LookItem } from '@outfitly/shared';
import { describe, expect, it } from 'vitest';
import { daysSince, dotPlacement, dotsOnPhoto, moneyLocale } from './shop';

describe('dotPlacement', () => {
  it('maps the dot straight onto a frame of the same shape', () => {
    const photo = { width: 800, height: 1200 };
    const frame = { width: 400, height: 600 };
    expect(dotPlacement(photo, frame, { x: 0.25, y: 0.5 })).toEqual({ left: 100, top: 300 });
  });

  it('accounts for the sides cropped off a photo wider than its frame', () => {
    // 1200×800 shown in a 400×400 frame: drawn 600×400, 100 cut off left and right.
    const photo = { width: 1200, height: 800 };
    const frame = { width: 400, height: 400 };
    expect(dotPlacement(photo, frame, { x: 0.5, y: 0.5 })).toEqual({ left: 200, top: 200 });
    expect(dotPlacement(photo, frame, { x: 0.25, y: 0 })).toEqual({ left: 50, top: 0 });
    // The leftmost 1/6 of the photo is cut off.
    expect(dotPlacement(photo, frame, { x: 0.1, y: 0.5 })).toBeNull();
  });

  it('accounts for the top and bottom cropped off a taller photo', () => {
    // 800×2000 in a 400×720 frame: drawn 400×1000, 140 cut off top and bottom.
    const photo = { width: 800, height: 2000 };
    const frame = { width: 400, height: 720 };
    expect(dotPlacement(photo, frame, { x: 0.5, y: 0.5 })).toEqual({ left: 200, top: 360 });
    expect(dotPlacement(photo, frame, { x: 0.5, y: 0.2 })).toEqual({ left: 200, top: 60 });
    expect(dotPlacement(photo, frame, { x: 0.5, y: 0.05 })).toBeNull();
    expect(dotPlacement(photo, frame, { x: 0.5, y: 0.95 })).toBeNull();
  });
});

describe('dotsOnPhoto', () => {
  const piece = (id: string, dot: LookItem['dot']) => ({ id, dot }) as LookItem;

  it('picks the pieces with a dot on that photo', () => {
    const items = [
      piece('a', { photo: 0, x: 0.1, y: 0.2 }),
      piece('b', { photo: 1, x: 0.3, y: 0.4 }),
      piece('c', null),
      piece('d', { photo: 0, x: 0.5, y: 0.6 }),
    ];
    expect(dotsOnPhoto(items, 0).map((d) => [d.item.id, d.x, d.y])).toEqual([
      ['a', 0.1, 0.2],
      ['d', 0.5, 0.6],
    ]);
    expect(dotsOnPhoto(items, 2)).toEqual([]);
  });
});

describe('daysSince', () => {
  const at = (y: number, m: number, d: number, h = 12) => new Date(y, m - 1, d, h);

  it('counts calendar days in the phone’s time zone', () => {
    const now = at(2026, 11, 5, 9);
    expect(daysSince(at(2026, 11, 5, 0).toISOString(), now)).toBe(0);
    expect(daysSince(at(2026, 11, 4, 23).toISOString(), now)).toBe(1);
    expect(daysSince(at(2026, 11, 2).toISOString(), now)).toBe(3);
    // Across the end of summer time (last Sunday of October in Europe).
    expect(daysSince(at(2026, 10, 20).toISOString(), now)).toBe(16);
  });

  it('treats a time in the future as today', () => {
    expect(daysSince(at(2026, 11, 6).toISOString(), at(2026, 11, 5))).toBe(0);
  });
});

describe('moneyLocale', () => {
  it('writes prices in the app’s language with the phone’s region', () => {
    expect(moneyLocale('en', 'SE')).toBe('en-SE');
    expect(moneyLocale('sv', 'SE')).toBe('sv-SE');
    expect(moneyLocale('sv', 'FI')).toBe('sv-FI');
  });

  it('falls back to a region of its own without a usable one', () => {
    expect(moneyLocale('sv', null)).toBe('sv-SE');
    expect(moneyLocale('en', undefined)).toBe('en-GB');
    expect(moneyLocale('en', '419')).toBe('en-GB');
  });
});
