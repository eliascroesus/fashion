import { describe, expect, it } from 'vitest';
import { generateHandle } from '../src/handles.ts';

const VALID = /^[a-z0-9._]{3,30}$/;

describe('generateHandle', () => {
  it.each([
    ['anna.svensson@example.com', /^anna\.svensson\d{4}$/],
    ['Åsa-Öberg+tag@example.se', /^asaobergtag\d{4}$/],
    ['..x..@example.com', /^user\d{4}$/],
    [undefined, /^user\d{4}$/],
    [`${'a'.repeat(40)}@example.com`, /^a{26}\d{4}$/],
  ])('makes a valid handle from %s', (email, pattern) => {
    const handle = generateHandle(email);
    expect(handle).toMatch(pattern);
    expect(handle).toMatch(VALID);
  });

  it('uses more digits when asked (after collisions)', () => {
    expect(generateHandle(undefined, 8)).toMatch(/^user\d{8}$/);
  });
});
