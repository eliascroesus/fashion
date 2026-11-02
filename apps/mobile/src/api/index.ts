import { randomUUID } from 'expo-crypto';
import { createApiClient } from './client';

/** Set per build (eas.json env, or apps/mobile/.env in development). */
function apiBaseUrl(): string {
  const url = process.env['EXPO_PUBLIC_API_URL'];
  if (url) return url;
  if (__DEV__) return 'http://localhost:8080';
  throw new Error('EXPO_PUBLIC_API_URL is not set for this build.');
}

export const api = createApiClient({
  baseUrl: apiBaseUrl(),
  // Logins arrive in Step 1.6.
  getAccessToken: () => Promise.resolve(null),
  newIdempotencyKey: randomUUID,
});

export { ApiRequestError } from './client';
