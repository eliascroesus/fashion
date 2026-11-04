import Ionicons from '@expo/vector-icons/Ionicons';
import type { ComponentProps, ReactNode } from 'react';
import { Pressable, StyleSheet, View } from 'react-native';
import { radii, spacing, ThemedText, useColors } from '../theme';

interface SheetRowProps {
  label: string;
  onPress: () => void;
  icon?: ComponentProps<typeof Ionicons>['name'];
  /** Instead of an icon, e.g. a board's cover photo. */
  leading?: ReactNode;
  detail?: string;
  /** A tick at the end (e.g. the look is on this board). */
  checked?: boolean;
  testID?: string;
}

/** One tappable line in a bottom sheet. */
export function SheetRow({
  label,
  onPress,
  icon,
  leading,
  detail,
  checked,
  testID,
}: SheetRowProps) {
  const colors = useColors();
  return (
    <Pressable
      testID={testID}
      accessibilityRole="button"
      accessibilityLabel={detail ? `${label}, ${detail}` : label}
      {...(checked === undefined ? {} : { accessibilityState: { checked } })}
      onPress={onPress}
      style={({ pressed }) => [
        styles.row,
        { backgroundColor: pressed ? colors.surfaceMuted : 'transparent' },
      ]}
    >
      {leading ??
        (icon ? (
          <View style={[styles.icon, { backgroundColor: colors.surfaceMuted }]}>
            <Ionicons name={icon} size={22} color={colors.text} />
          </View>
        ) : null)}
      <View style={styles.text}>
        <ThemedText variant="bodyStrong" numberOfLines={1}>
          {label}
        </ThemedText>
        {detail ? (
          <ThemedText variant="caption" tone="muted">
            {detail}
          </ThemedText>
        ) : null}
      </View>
      {checked ? <Ionicons name="checkmark-circle" size={24} color={colors.accent} /> : null}
    </Pressable>
  );
}

/** Rows in a sheet are this tall (board picker thumbnails match it). */
export const SHEET_ROW_ICON = 48;

const styles = StyleSheet.create({
  row: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: spacing.md,
    paddingHorizontal: spacing.xl,
    paddingVertical: spacing.sm,
  },
  icon: {
    width: SHEET_ROW_ICON,
    height: SHEET_ROW_ICON,
    borderRadius: radii.md,
    alignItems: 'center',
    justifyContent: 'center',
  },
  text: { flex: 1, gap: spacing.xxs },
});
