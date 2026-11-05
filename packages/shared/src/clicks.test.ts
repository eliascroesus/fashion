import { describe, expect, it } from 'vitest';
import {
  CLICK_SOURCES,
  clickBatchInputSchema,
  clickBatchSchema,
  EVENT_SOURCES,
  MAX_CLICK_BATCH,
  MAX_FEED_POSITION,
} from './index.ts';

const click = {
  id: '0b7c9f0e-3a51-4c56-9d2e-6f1a2b3c4d5e',
  lookId: '3f9a2c1b-4d5e-4f60-8a1b-2c3d4e5f6a7b',
  offerId: '7d1e2f3a-4b5c-4d6e-8f70-819a2b3c4d5e',
  source: 'feed_for_you',
  position: 3,
  tappedAt: '2026-11-05T10:00:00.000Z',
};
const batch = {
  sessionId: '9a8b7c6d-5e4f-4a3b-8c2d-1e0f9a8b7c6d',
  platform: 'ios',
  clicks: [click],
};

describe('click batches', () => {
  it('accepts a batch of clicks', () => {
    expect(clickBatchSchema.parse(batch)).toEqual(batch);
  });

  it('accepts a look that was not opened from a list', () => {
    const clicks = [{ ...click, source: null, position: null }];
    expect(clickBatchSchema.safeParse({ ...batch, clicks }).success).toBe(true);
  });

  it(`takes 1 to ${String(MAX_CLICK_BATCH)} clicks`, () => {
    expect(clickBatchSchema.safeParse({ ...batch, clicks: [] }).success).toBe(false);
    const full = Array.from({ length: MAX_CLICK_BATCH }, () => click);
    expect(clickBatchSchema.safeParse({ ...batch, clicks: full }).success).toBe(true);
    expect(clickBatchSchema.safeParse({ ...batch, clicks: [...full, click] }).success).toBe(false);
  });

  it('knows every list impressions come from', () => {
    for (const source of EVENT_SOURCES) expect(CLICK_SOURCES).toContain(source);
  });

  it('the server reads each click on its own, so one odd click never refuses the batch', () => {
    const clicks = [click, { ...click, source: 'somewhere' }];
    expect(clickBatchSchema.safeParse({ ...batch, clicks }).success).toBe(false);
    expect(clickBatchInputSchema.safeParse({ ...batch, clicks }).success).toBe(true);
    expect(clickBatchInputSchema.safeParse({ ...batch, clicks: [] }).success).toBe(false);
  });

  it.each([
    ['an unknown source', { source: 'somewhere' }],
    ['a negative position', { position: -1 }],
    ['a place past the furthest one', { position: MAX_FEED_POSITION + 1 }],
    ['no tap time', { tappedAt: undefined }],
    ['a click id that is not a UUID', { id: 'abc' }],
    ['no offer', { offerId: undefined }],
  ])('refuses %s', (_label, change) => {
    const clicks = [{ ...click, ...change }];
    expect(clickBatchSchema.safeParse({ ...batch, clicks }).success).toBe(false);
  });
});
