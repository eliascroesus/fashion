import {
  type ThemeColors,
  type ThemeName,
  themes,
  typography,
  type TypographyVariant,
} from '@outfitly/ui-tokens';
import type { ReactNode } from 'react';
import {
  StyleSheet,
  Text,
  type TextProps,
  useColorScheme,
  View,
  type ViewProps,
} from 'react-native';

export { grid, radii, spacing, typography } from '@outfitly/ui-tokens';

/** Follows the phone's light/dark setting (the default theme is an open decision for Step 5.3). */
export function useThemeName(): ThemeName {
  return useColorScheme() === 'dark' ? 'dark' : 'light';
}

export function useColors(): ThemeColors {
  return themes[useThemeName()];
}

interface ThemedTextProps extends TextProps {
  variant?: TypographyVariant;
  tone?: 'default' | 'muted';
}

/** All on-screen text goes through this, in the theme's colours. */
export function ThemedText({
  variant = 'body',
  tone = 'default',
  style,
  ...rest
}: ThemedTextProps) {
  const colors = useColors();
  return (
    <Text
      style={[
        typography[variant],
        { color: tone === 'muted' ? colors.textMuted : colors.text },
        style,
      ]}
      {...rest}
    />
  );
}

/** A full screen on the theme's background. */
export function Screen({ style, children, ...rest }: ViewProps & { children?: ReactNode }) {
  const colors = useColors();
  return (
    <View style={[styles.screen, { backgroundColor: colors.background }, style]} {...rest}>
      {children}
    </View>
  );
}

const styles = StyleSheet.create({
  screen: { flex: 1 },
});
