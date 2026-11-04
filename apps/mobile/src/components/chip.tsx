import { Pressable, StyleSheet } from 'react-native';
import { radii, spacing, ThemedText, useColors } from '../theme';

interface ChipProps {
  label: string;
  selected: boolean;
  onPress: () => void;
  testID?: string;
}

/** A pill to tick on or off (style and brand picks). */
export function Chip({ label, selected, onPress, testID }: ChipProps) {
  const colors = useColors();
  return (
    <Pressable
      testID={testID}
      accessibilityRole="checkbox"
      accessibilityLabel={label}
      accessibilityState={{ checked: selected }}
      onPress={onPress}
      style={({ pressed }) => [
        styles.chip,
        {
          backgroundColor: selected ? colors.accent : colors.surface,
          borderColor: selected ? colors.accent : colors.border,
          opacity: pressed ? 0.7 : 1,
        },
      ]}
    >
      <ThemedText variant="bodyStrong" style={{ color: selected ? colors.onAccent : colors.text }}>
        {label}
      </ThemedText>
    </Pressable>
  );
}

const styles = StyleSheet.create({
  chip: {
    minHeight: 44,
    justifyContent: 'center',
    paddingHorizontal: spacing.lg,
    borderRadius: radii.pill,
    borderWidth: StyleSheet.hairlineWidth,
  },
});
