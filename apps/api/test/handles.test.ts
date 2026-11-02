import { describe, expect, it } from 'vitest';
import { generateHandle } from '../src/handles.ts';

const VALID = /^[a-z0-9._]{3,30}$/;

describe('generateHandle', () => {
  it('makes a valid user + digits handle that never reveals an email', () => {
    const handle = generateHandle();
    expect(handle).toMatch(/^user\d{4}$/);
    expect(handle).toMatch(VALID);
  });

  it('uses more digits when asked (after collisions)', () => {
    expect(generateHandle(8)).toMatch(/^user\d{8}$/);
  });
});
