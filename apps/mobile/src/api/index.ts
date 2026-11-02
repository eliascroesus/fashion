import { randomUUID } from 'expo-crypto';
import { getActiveProfileId } from '../auth/store';
import { getAccessToken } from '../auth/supabase';
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
});

export { ApiRequestError } from './client';
