import { describe, expect, it } from 'vitest';
import { type ThemeColors, themes } from './index.ts';

/** WCAG 2.x relative luminance and contrast ratio. */
function luminance(hex: string): number {
  const channels = [1, 3, 5].map((i) => parseInt(hex.slice(i, i + 2), 16) / 255);
  const [r = 0, g = 0, b = 0] = channels.map((c) =>
    c <= 0.03928 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4,
  );
  return 0.2126 * r + 0.7152 * g + 0.0722 * b;
}
function contrast(a: string, b: string): number {
  const [hi, lo] = [luminance(a), luminance(b)].sort((x, y) => y - x);
  return ((hi ?? 0) + 0.05) / ((lo ?? 0) + 0.05);
}

const PAIRS: [keyof ThemeColors, keyof ThemeColors, number][] = [
  ['text', 'background', 4.5],
  ['text', 'surface', 4.5],
  ['textMuted', 'background', 4.5],
  ['textMuted', 'surface', 4.5],
  ['onAccent', 'accent', 4.5],
  ['tabActive', 'surface', 4.5],
  // Inactive icons are large and paired with an active state: WCAG non-text minimum.
  ['tabInactive', 'surface', 3],
  ['danger', 'background', 4.5],
];

describe.each(Object.entries(themes))('%s theme', (_name, colors) => {
  it('uses six-digit lowercase hex colours only', () => {
    for (const value of Object.values(colors)) expect(value).toMatch(/^#[0-9a-f]{6}$/);
  });

  it.each(PAIRS)('%s on %s is readable (≥ %s:1)', (fg, bg, min) => {
    expect(contrast(colors[fg], colors[bg])).toBeGreaterThanOrEqual(min);
  });
});

describe('themes', () => {
  it('define the same colour roles', () => {
    expect(Object.keys(themes.dark).sort()).toEqual(Object.keys(themes.light).sort());
  });
});
