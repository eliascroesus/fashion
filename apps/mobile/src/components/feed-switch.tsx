import { useTranslation } from 'react-i18next';
import { Pressable, StyleSheet, View } from 'react-native';
import type { FeedKind } from '../feed/keys';
import { radii, spacing, ThemedText, useColors } from '../theme';

const OPTIONS: { kind: FeedKind; label: 'feed.forYou' | 'feed.following' }[] = [
  { kind: 'for-you', label: 'feed.forYou' },
  { kind: 'following', label: 'feed.following' },
];

/** The For You / Following switch at the top of Home; the active one is underlined. */
export function FeedSwitch({
  value,
  onChange,
}: {
  value: FeedKind;
  onChange: (kind: FeedKind) => void;
}) {
  const { t } = useTranslation();
  const colors = useColors();
  return (
    <View style={styles.row} accessibilityRole="tablist">
      {OPTIONS.map(({ kind, label }) => {
        const selected = kind === value;
        return (
          <Pressable
            key={kind}
            testID={`feed-switch-${kind}`}
            accessibilityRole="tab"
            accessibilityState={{ selected }}
            onPress={() => {
              onChange(kind);
            }}
            hitSlop={spacing.sm}
            style={styles.option}
          >
            <ThemedText variant="bodyStrong" tone={selected ? 'default' : 'muted'}>
              {t(label)}
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
