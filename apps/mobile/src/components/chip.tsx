import { Pressable, StyleSheet } from 'react-native';
import { radii, spacing, ThemedText, useColors } from '../theme';

interface ChipProps {
  label: string;
  /** Ticked or not (style and brand picks); leave it out for a chip that's a button. */
  selected?: boolean;
  onPress: () => void;
  testID?: string;
}

/** A pill to tick on or off (style and brand picks), or to tap (search's popular tags). */
export function Chip({ label, selected, onPress, testID }: ChipProps) {
  const colors = useColors();
  const ticked = selected === true;
  return (
    <Pressable
      testID={testID}
      accessibilityRole={selected === undefined ? 'button' : 'checkbox'}
      accessibilityLabel={label}
      {...(selected === undefined ? {} : { accessibilityState: { checked: selected } })}
      onPress={onPress}
      style={({ pressed }) => [
        styles.chip,
        {
          backgroundColor: ticked ? colors.accent : colors.surface,
          borderColor: ticked ? colors.accent : colors.border,
          opacity: pressed ? 0.7 : 1,
        },
      ]}
    >
      <ThemedText variant="bodyStrong" style={{ color: ticked ? colors.onAccent : colors.text }}>
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
