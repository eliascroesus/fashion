import { describe, expect, it } from 'vitest';
import { API_PREFIX, FEED_PAGE_SIZE } from './index';

describe('shared constants', () => {
  it('keeps the API under /v1', () => {
    expect(API_PREFIX).toBe('/v1');
  });

  it('pages feeds 20 at a time', () => {
    expect(FEED_PAGE_SIZE).toBe(20);
  });
});
