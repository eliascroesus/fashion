import { ApiRequestError } from '../api/client';

/** Retry network trouble and server errors, but not answers like 404 that won't change. */
export function shouldRetry(failureCount: number, error: unknown): boolean {
  if (failureCount >= 2) return false;
  if (!(error instanceof ApiRequestError)) return true;
  const clientError = error.status >= 400 && error.status < 500;
  return !clientError || error.status === 408 || error.status === 429;
}
