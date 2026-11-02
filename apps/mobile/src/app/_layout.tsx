import '../i18n';
import { PersistQueryClientProvider } from '@tanstack/react-query-persist-client';
import { Stack } from 'expo-router';
import { StatusBar } from 'expo-status-bar';
import { PERSIST_MAX_AGE, queryClient, queryPersister } from '../lib/query';
import { initSentry, Sentry } from '../lib/sentry';
import { useColors, useThemeName } from '../theme';

initSentry();

function RootLayout() {
  const colors = useColors();
  const themeName = useThemeName();
  return (
    <PersistQueryClientProvider
      client={queryClient}
      persistOptions={{ persister: queryPersister, maxAge: PERSIST_MAX_AGE }}
    >
      <StatusBar style={themeName === 'dark' ? 'light' : 'dark'} />
      <Stack
        screenOptions={{ headerShown: false, contentStyle: { backgroundColor: colors.background } }}
      >
        <Stack.Screen name="(tabs)" />
      </Stack>
    </PersistQueryClientProvider>
  );
}

export default Sentry.wrap(RootLayout);
