/**
 * Design tokens. Every colour in the product comes from here, by role, so
 * the light and dark themes stay in step and contrast is tested.
 */

export interface ThemeColors {
  /** Screen background. */
  background: string;
  /** Cards, sheets, tab bar. */
  surface: string;
  /** Placeholders, chips, pressed states. */
  surfaceMuted: string;
  border: string;
  text: string;
  textMuted: string;
  /** Brand colour: primary buttons (e.g. Shop), active highlights. */
  accent: string;
  /** Text and icons on top of `accent`. */
  onAccent: string;
  danger: string;
  /** Tab bar icons. */
  tabActive: string;
  tabInactive: string;
}

export type ThemeName = 'light' | 'dark';

/** Warm, editorial: off-white paper, ink-brown text, terracotta accent. */
const light: ThemeColors = {
  background: '#faf7f2',
  surface: '#ffffff',
  surfaceMuted: '#f1ebe3',
  border: '#e4dbd0',
  text: '#1f1a16',
  textMuted: '#6b6158',
  accent: '#a84b33',
  onAccent: '#ffffff',
  danger: '#b3261e',
  tabActive: '#1f1a16',
  tabInactive: '#8a8077',
};

/** Warm charcoal rather than pure black, so photos stay the brightest thing on screen. */
const dark: ThemeColors = {
  background: '#14110f',
  surface: '#1d1916',
  surfaceMuted: '#2a2420',
  border: '#3a322c',
  text: '#f5efe8',
  textMuted: '#a99f95',
  accent: '#e8866b',
  onAccent: '#1f1a16',
  danger: '#f2b8b5',
  tabActive: '#f5efe8',
  tabInactive: '#8f857b',
};

export const themes: Record<ThemeName, ThemeColors> = { light, dark };

/** 4-point grid. */
export const spacing = {
  xxs: 2,
  xs: 4,
  sm: 8,
  md: 12,
  lg: 16,
  xl: 24,
  xxl: 32,
  xxxl: 48,
} as const;

export const radii = {
  sm: 6,
  md: 12,
  lg: 20,
  pill: 999,
} as const;

export const fontWeights = {
  regular: '400',
  medium: '500',
  semibold: '600',
  bold: '700',
} as const;

/** Type scale: size and line height in points. */
export const typography = {
  caption: { fontSize: 12, lineHeight: 16, fontWeight: fontWeights.regular },
  body: { fontSize: 15, lineHeight: 21, fontWeight: fontWeights.regular },
  bodyStrong: { fontSize: 15, lineHeight: 21, fontWeight: fontWeights.semibold },
  title: { fontSize: 20, lineHeight: 26, fontWeight: fontWeights.semibold },
  headline: { fontSize: 26, lineHeight: 32, fontWeight: fontWeights.bold },
} as const;

export type TypographyVariant = keyof typeof typography;

/** Masonry feed: two columns with a small gap, Pinterest-style. */
export const grid = {
  columns: 2,
  gap: 6,
  /** Outer padding of the feed. */
  inset: 6,
} as const;
