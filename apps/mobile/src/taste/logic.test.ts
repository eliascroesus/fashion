import { describe, expect, it } from 'vitest';
import { preselectStyles, toggle } from './logic';

describe('preselectStyles', () => {
  it('ticks the styles of the liked looks, the most liked first, at most 3', () => {
    const liked = [
      { styles: ['edgy'] },
      { styles: ['streetwear'] },
      { styles: ['streetwear', 'sporty'] },
      { styles: ['minimal'] },
      { styles: ['streetwear'] },
    ];
    expect(preselectStyles(liked)).toEqual(['streetwear', 'minimal', 'sporty']);
  });

  it('breaks ties in list order and ignores unknown styles', () => {
    expect(preselectStyles([{ styles: ['edgy', 'goth'] }, { styles: ['classic'] }])).toEqual([
      'classic',
      'edgy',
    ]);
    expect(preselectStyles([])).toEqual([]);
  });
});

describe('toggle', () => {
  it('adds a missing value and removes a present one', () => {
    expect(toggle(['a'], 'b')).toEqual(['a', 'b']);
    expect(toggle(['a', 'b'], 'a')).toEqual(['b']);
  });
});
