import { describe, expect, it } from 'vitest';
import { API_PREFIX, apiErrorSchema, FEED_PAGE_SIZE, IDEMPOTENCY_KEY_PATTERN } from './index.ts';

describe('shared constants', () => {
  it('keeps the API under /v1', () => {
    expect(API_PREFIX).toBe('/v1');
  });

  it('pages feeds 20 at a time', () => {
    expect(FEED_PAGE_SIZE).toBe(20);
  });
});

describe('idempotency keys', () => {
  it('accepts UUIDs and rejects short or odd keys', () => {
    expect(IDEMPOTENCY_KEY_PATTERN.test('0b7c9f0e-3a51-4c56-9d2e-6f1a2b3c4d5e')).toBe(true);
    expect(IDEMPOTENCY_KEY_PATTERN.test('short')).toBe(false);
    expect(IDEMPOTENCY_KEY_PATTERN.test('has spaces in it')).toBe(false);
  });
});

describe('api error format', () => {
  it('parses a valid error and rejects unknown codes', () => {
    const body = { error: { code: 'not_found', message: 'Nope', requestId: 'r1' } };
    expect(apiErrorSchema.parse(body)).toEqual(body);
    expect(apiErrorSchema.safeParse({ error: { ...body.error, code: 'teapot' } }).success).toBe(
      false,
    );
  });
});
