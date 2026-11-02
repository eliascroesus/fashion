import '../i18n';
import { PersistQueryClientProvider } from '@tanstack/react-query-persist-client';
import Constants from 'expo-constants';
import { type ErrorBoundaryProps, Stack, ThemeProvider } from 'expo-router';
import { StatusBar } from 'expo-status-bar';
import { useTranslation } from 'react-i18next';
import { Pressable, StyleSheet } from 'react-native';
import { AuthProvider } from '../auth/AuthProvider';
import { CaptchaProvider } from '../auth/captcha';
import { PERSIST_MAX_AGE, queryClient, queryPersister } from '../lib/query';
import { initSentry, Sentry } from '../lib/sentry';
import { radii, Screen, spacing, ThemedText, useColors, useThemeName } from '../theme';
import { navigationTheme } from '../theme/navigation';

initSentry();

/** A new app version starts with a fresh cache, so old data shapes are never restored. */
const CACHE_VERSION = Constants.expoConfig?.version ?? 'dev';

function RootLayout() {
  const colors = useColors();
  const themeName = useThemeName();
  return (
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
              <Stack.Screen name="(tabs)" />
              <Stack.Screen name="sign-up" options={{ presentation: 'modal' }} />
              <Stack.Screen name="auth-callback" />
            </Stack>
          </AuthProvider>
        </CaptchaProvider>
      </PersistQueryClientProvider>
    </ThemeProvider>
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
  center: { alignItems: 'center', justifyContent: 'center', padding: spacing.xl },
  button: {
    marginTop: spacing.lg,
    paddingVertical: spacing.md,
    paddingHorizontal: spacing.xl,
    borderRadius: radii.pill,
  },
});
