import { describe, expect, it } from 'vitest';
import { ApiRequestError } from '../api/client';
import { shouldRetry } from './query-retry';

const err = (status: number) => new ApiRequestError(status, 'x', 'x');

describe('query retries', () => {
  it('retry network failures and server errors up to twice', () => {
    expect(shouldRetry(0, err(0))).toBe(true);
    expect(shouldRetry(1, err(503))).toBe(true);
    expect(shouldRetry(2, err(503))).toBe(false);
  });

  it('do not retry answers that will not change, except timeouts and rate limits', () => {
    expect(shouldRetry(0, err(404))).toBe(false);
    expect(shouldRetry(0, err(401))).toBe(false);
    expect(shouldRetry(0, err(408))).toBe(true);
    expect(shouldRetry(0, err(429))).toBe(true);
  });
});
