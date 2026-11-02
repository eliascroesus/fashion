import * as Sentry from '@sentry/react-native';

const dsn = process.env['EXPO_PUBLIC_SENTRY_DSN'];

/** Crash and error reporting. Off when no DSN is set (local development). */
export function initSentry(): void {
  Sentry.init({
    dsn,
    enabled: Boolean(dsn),
    environment: process.env['EXPO_PUBLIC_APP_ENV'] ?? 'development',
    tracesSampleRate: 0,
    // Personal data (IP, user details, headers) stays off: Sentry's default
    // here. Don't turn on sendDefaultPii.
  });
}

export { Sentry };
