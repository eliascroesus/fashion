import { describe, expect, it } from 'vitest';
import { eventBatchSchema, MAX_EVENT_BATCH } from './index.ts';

const impression = {
  id: '0b7c9f0e-3a51-4c56-9d2e-6f1a2b3c4d5e',
  name: 'impression',
  lookId: '3f9a2c1b-4d5e-4f60-8a1b-2c3d4e5f6a7b',
  position: 0,
  source: 'feed_for_you',
  occurredAt: '2026-11-03T10:00:00.000Z',
};
const batch = {
  sessionId: '9a8b7c6d-5e4f-4a3b-8c2d-1e0f9a8b7c6d',
  platform: 'ios',
  events: [impression],
};

describe('event batches', () => {
  it('accepts a batch of impressions', () => {
    expect(eventBatchSchema.parse(batch)).toEqual(batch);
  });

  it(`takes 1 to ${String(MAX_EVENT_BATCH)} events`, () => {
    expect(eventBatchSchema.safeParse({ ...batch, events: [] }).success).toBe(false);
    const full = Array.from({ length: MAX_EVENT_BATCH }, () => impression);
    expect(eventBatchSchema.safeParse({ ...batch, events: full }).success).toBe(true);
    expect(eventBatchSchema.safeParse({ ...batch, events: [...full, impression] }).success).toBe(
      false,
    );
  });

  it.each([
    ['an event name the app may not send yet', { name: 'click' }],
    ['an unknown source', { source: 'somewhere' }],
    ['a negative position', { position: -1 }],
    ['an id that is not a UUID', { id: 'abc' }],
    ['a time without a zone', { occurredAt: '2026-11-03T10:00:00' }],
  ])('refuses %s', (_label, change) => {
    const events = [{ ...impression, ...change }];
    expect(eventBatchSchema.safeParse({ ...batch, events }).success).toBe(false);
  });
});
