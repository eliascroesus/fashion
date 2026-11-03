import { useSyncExternalStore } from 'react';
import { AccessibilityInfo, StyleSheet, View } from 'react-native';
import Animated, { FadeInDown, FadeOut } from 'react-native-reanimated';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { radii, spacing, ThemedText, useColors } from '../theme';

/** How long a message stays. */
const SHOW_MS = 2_500;
/** Clear of the tab bar. */
const ABOVE_TABS = 64;

let current: { id: number; text: string } | null = null;
let nextId = 0;
const listeners = new Set<() => void>();

function emit(): void {
  for (const listener of listeners) listener();
}

/** A short message at the bottom of the screen, e.g. "Saved to Summer". */
export function showToast(text: string): void {
  const id = ++nextId;
  current = { id, text };
  emit();
  AccessibilityInfo.announceForAccessibility(text);
  setTimeout(() => {
    if (current?.id !== id) return;
    current = null;
    emit();
  }, SHOW_MS);
}

function subscribe(listener: () => void): () => void {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

/** Shows the current message over every screen (placed once, in the root layout). */
export function ToastHost() {
  const colors = useColors();
  const insets = useSafeAreaInsets();
  const toast = useSyncExternalStore(subscribe, () => current);
  return (
    <View pointerEvents="none" style={[styles.host, { bottom: insets.bottom + ABOVE_TABS }]}>
      {toast ? (
        <Animated.View
          key={toast.id}
          entering={FadeInDown.duration(180)}
          exiting={FadeOut.duration(180)}
          style={[styles.toast, { backgroundColor: colors.text }]}
          testID="toast"
        >
          <ThemedText variant="bodyStrong" style={{ color: colors.background }}>
            {toast.text}
          </ThemedText>
        </Animated.View>
      ) : null}
    </View>
  );
}

const styles = StyleSheet.create({
  host: { position: 'absolute', left: spacing.lg, right: spacing.lg, alignItems: 'center' },
  toast: {
    paddingHorizontal: spacing.lg,
    paddingVertical: spacing.md,
    borderRadius: radii.pill,
    maxWidth: '100%',
  },
});
