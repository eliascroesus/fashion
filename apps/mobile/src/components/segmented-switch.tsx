import { Pressable, StyleSheet, View } from 'react-native';
import { radii, spacing, ThemedText, useColors } from '../theme';

interface SegmentedSwitchProps<T extends string> {
  options: readonly { value: T; label: string }[];
  value: T;
  onChange: (value: T) => void;
  /** Each option gets the test id `${testIDPrefix}-${value}`. */
  testIDPrefix: string;
}

/** Two or three tabs in a row at the top of a screen; the active one is underlined. */
export function SegmentedSwitch<T extends string>({
  options,
  value,
  onChange,
  testIDPrefix,
}: SegmentedSwitchProps<T>) {
  const colors = useColors();
  return (
    <View style={styles.row} accessibilityRole="tablist">
      {options.map((option) => {
        const selected = option.value === value;
        return (
          <Pressable
            key={option.value}
            testID={`${testIDPrefix}-${option.value}`}
            accessibilityRole="tab"
            accessibilityState={{ selected }}
            onPress={() => {
              onChange(option.value);
            }}
            hitSlop={spacing.sm}
            style={styles.option}
          >
            <ThemedText variant="bodyStrong" tone={selected ? 'default' : 'muted'}>
              {option.label}
            </ThemedText>
            <View
              style={[
                styles.underline,
                { backgroundColor: selected ? colors.text : 'transparent' },
              ]}
            />
          </Pressable>
        );
      })}
    </View>
  );
}

const styles = StyleSheet.create({
  row: {
    flexDirection: 'row',
    justifyContent: 'center',
    gap: spacing.xl,
    paddingTop: spacing.sm,
    paddingBottom: spacing.xs,
  },
  option: { alignItems: 'center', gap: spacing.xs },
  underline: { height: 2, alignSelf: 'stretch', borderRadius: radii.pill },
});
