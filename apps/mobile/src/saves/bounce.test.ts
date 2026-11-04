import { describe, expect, it } from 'vitest';
import { justSaved } from './bounce';

describe('justSaved', () => {
  it('is true when the same look goes from not saved to saved', () => {
    expect(justSaved({ lookId: 'a', saved: false }, { lookId: 'a', saved: true })).toBe(true);
  });

  it('is false when a reused grid cell now shows another look that was already saved', () => {
    expect(justSaved({ lookId: 'a', saved: false }, { lookId: 'b', saved: true })).toBe(false);
  });

  it('is false when nothing changed or the look was unsaved', () => {
    expect(justSaved({ lookId: 'a', saved: true }, { lookId: 'a', saved: true })).toBe(false);
    expect(justSaved({ lookId: 'a', saved: true }, { lookId: 'a', saved: false })).toBe(false);
  });
});
