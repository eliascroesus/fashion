import { describe, expect, it } from 'vitest';
import { GARMENT_CATEGORIES } from './index.ts';

describe('garment categories', () => {
  it('are unique lowercase ids (they become a database enum)', () => {
    expect(new Set(GARMENT_CATEGORIES).size).toBe(GARMENT_CATEGORIES.length);
    for (const category of GARMENT_CATEGORIES) expect(category).toMatch(/^[a-z]+(_[a-z]+)*$/);
  });
});
