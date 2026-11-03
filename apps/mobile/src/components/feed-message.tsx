import { StyleSheet, View } from 'react-native';
import { spacing, ThemedText } from '../theme';
import { Button } from './button';

interface FeedMessageProps {
  title?: string;
  body: string;
  action?: { label: string; onPress: () => void };
  testID?: string;
}

/** Empty, logged-out and error states inside a feed. */
export function FeedMessage({ title, body, action, testID }: FeedMessageProps) {
  return (
    <View style={styles.box} testID={testID}>
      {title ? (
        <ThemedText variant="title" accessibilityRole="header" style={styles.text}>
          {title}
        </ThemedText>
      ) : null}
      <ThemedText tone="muted" style={styles.text}>
        {body}
      </ThemedText>
      {action ? (
        <Button
          variant="secondary"
          label={action.label}
          onPress={action.onPress}
          style={styles.button}
        />
      ) : null}
    </View>
  );
}

const styles = StyleSheet.create({
  box: { alignItems: 'center', padding: spacing.xl, gap: spacing.sm },
  text: { textAlign: 'center' },
  button: { marginTop: spacing.md },
});
