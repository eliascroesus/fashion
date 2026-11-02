import { StyleSheet } from 'react-native';
import { Screen, spacing, ThemedText } from '../theme';

/** Temporary content for tabs whose real screens come in later steps. */
export function PlaceholderScreen({ title, body }: { title: string; body: string }) {
  return (
    <Screen style={styles.center}>
      <ThemedText variant="headline" accessibilityRole="header">
        {title}
      </ThemedText>
      <ThemedText tone="muted" style={styles.body}>
        {body}
      </ThemedText>
    </Screen>
  );
}

const styles = StyleSheet.create({
  center: { alignItems: 'center', justifyContent: 'center', padding: spacing.xl },
  body: { marginTop: spacing.sm, textAlign: 'center' },
});
