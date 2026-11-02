import { randomUUID } from 'expo-crypto';
import { createApiClient } from './client';

/** Set per build (EAS env / .env): the API this app talks to. */
const baseUrl = process.env['EXPO_PUBLIC_API_URL'] ?? 'http://localhost:8080';

export const api = createApiClient({
  baseUrl,
  // Logins arrive in Step 1.6.
  getAccessToken: () => Promise.resolve(null),
  newIdempotencyKey: randomUUID,
});

export { ApiRequestError } from './client';
