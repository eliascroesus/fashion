import type { ThemeColors } from '@outfitly/ui-tokens';
import { DarkTheme, DefaultTheme, type Theme } from 'expo-router';

/** React Navigation's theme built from our tokens, so screen containers never flash the wrong colour. */
export function navigationTheme(colors: ThemeColors, dark: boolean): Theme {
  const base = dark ? DarkTheme : DefaultTheme;
  return {
    ...base,
    dark,
    colors: {
      ...base.colors,
      primary: colors.accent,
      background: colors.background,
      card: colors.surface,
      text: colors.text,
      border: colors.border,
      notification: colors.accent,
    },
  };
}
