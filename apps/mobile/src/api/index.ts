import { randomUUID } from 'expo-crypto';
import { getActiveProfileId } from '../auth/store';
import { getAccessToken } from '../auth/supabase';
import { isPretendOffline } from '../lib/dev';
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
  getAccessToken,
  getActiveProfileId,
  newIdempotencyKey: randomUUID,
  // The developer menu's "Pretend offline" fails requests like airplane mode does.
  fetch: (input, init) =>
    isPretendOffline()
      ? Promise.reject(new TypeError('Network request failed (pretend offline)'))
      : fetch(input, init),
});

export { ApiRequestError } from './client';
