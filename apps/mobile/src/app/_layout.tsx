import '../i18n';
// Starts the Shop click queue: clicks kept on the phone are sent at app start.
import '../clicks';
import { PersistQueryClientProvider } from '@tanstack/react-query-persist-client';
import Constants from 'expo-constants';
import { type ErrorBoundaryProps, Stack, ThemeProvider } from 'expo-router';
import { StatusBar } from 'expo-status-bar';
import { useTranslation } from 'react-i18next';
import { Pressable, StyleSheet } from 'react-native';
import { GestureHandlerRootView } from 'react-native-gesture-handler';
import { AuthProvider } from '../auth/AuthProvider';
import { CaptchaProvider } from '../auth/captcha';
import { ToastHost } from '../components/toast';
import { CACHE_SHAPE, PERSIST_MAX_AGE, queryClient, queryPersister } from '../lib/query';
import { initSentry, Sentry } from '../lib/sentry';
import { usePickerDone } from '../taste';
import { radii, Screen, spacing, ThemedText, useColors, useThemeName } from '../theme';
import { navigationTheme } from '../theme/navigation';

initSentry();

/**
 * A new app version, or a new cache shape, starts with a fresh cache, so old
 * data shapes are never restored.
 */
const CACHE_VERSION = `${Constants.expoConfig?.version ?? 'dev'}-${String(CACHE_SHAPE)}`;

/** Small sheets that rise from the bottom, as tall as what's in them. */
const SHEET = {
  presentation: 'formSheet',
  sheetAllowedDetents: 'fitToContents',
  sheetGrabberVisible: true,
  sheetCornerRadius: radii.lg,
} as const;

function RootLayout() {
  const colors = useColors();
  const themeName = useThemeName();
  const pickerDone = usePickerDone();
  return (
    <GestureHandlerRootView style={styles.root}>
      <ThemeProvider value={navigationTheme(colors, themeName === 'dark')}>
        <PersistQueryClientProvider
          client={queryClient}
          persistOptions={{
            persister: queryPersister,
            maxAge: PERSIST_MAX_AGE,
            buster: CACHE_VERSION,
          }}
        >
          <CaptchaProvider>
            <AuthProvider>
              <StatusBar style={themeName === 'dark' ? 'light' : 'dark'} />
              <Stack
                screenOptions={{
                  headerShown: false,
                  contentStyle: { backgroundColor: colors.background },
                }}
              >
                {/* The taste picker comes first at the first open; Home never shows before it. */}
                <Stack.Protected guard={pickerDone}>
                  <Stack.Screen name="(tabs)" />
                </Stack.Protected>
                <Stack.Protected guard={!pickerDone}>
                  <Stack.Screen
                    name="taste"
                    options={{ gestureEnabled: false, animation: 'fade' }}
                  />
                </Stack.Protected>
                <Stack.Screen name="look/[id]" />
                <Stack.Screen name="board/[id]" />
                <Stack.Screen name="profile/[id]" />
                <Stack.Screen name="look-menu/[id]" options={SHEET} />
                <Stack.Screen
                  name="save-to-board/[id]"
                  options={{ ...SHEET, sheetAllowedDetents: [0.6, 1] }}
                />
                <Stack.Screen name="board-name" options={SHEET} />
                <Stack.Screen name="sign-up" options={{ presentation: 'modal' }} />
                <Stack.Screen name="auth-callback" />
              </Stack>
              <ToastHost />
            </AuthProvider>
          </CaptchaProvider>
        </PersistQueryClientProvider>
      </ThemeProvider>
    </GestureHandlerRootView>
  );
}

export default Sentry.wrap(RootLayout);

/** Shown instead of a crashed screen; Expo Router passes a retry function. */
export function ErrorBoundary({ retry }: ErrorBoundaryProps) {
  const { t } = useTranslation();
  const colors = useColors();
  return (
    <Screen style={styles.center}>
      <ThemedText variant="title">{t('errors.generic')}</ThemedText>
      <Pressable
        accessibilityRole="button"
        onPress={() => void retry()}
        style={[styles.button, { backgroundColor: colors.accent }]}
      >
        <ThemedText variant="bodyStrong" style={{ color: colors.onAccent }}>
          {t('errors.retry')}
        </ThemedText>
      </Pressable>
    </Screen>
  );
}

const styles = StyleSheet.create({
  root: { flex: 1 },
  center: { alignItems: 'center', justifyContent: 'center', padding: spacing.xl },
  button: {
    marginTop: spacing.lg,
    paddingVertical: spacing.md,
    paddingHorizontal: spacing.xl,
    borderRadius: radii.pill,
  },
});
