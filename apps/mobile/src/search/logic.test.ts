import { describe, expect, it } from 'vitest';
import { MAX_RECENT_SEARCHES, readRecent, tidySearch, withRecent } from './logic';

describe('recent searches', () => {
  it('puts the newest first, once, ignoring case, tidied', () => {
    expect(withRecent(['linen', 'jeans'], '  Jeans   wide ')).toEqual([
      'Jeans wide',
      'linen',
      'jeans',
    ]);
    expect(withRecent(['linen', 'jeans'], 'JEANS')).toEqual(['JEANS', 'linen']);
  });

  it(`keeps at most ${String(MAX_RECENT_SEARCHES)}`, () => {
    let list: string[] = [];
    for (let i = 0; i < 15; i++) list = withRecent(list, `search ${String(i)}`);
    expect(list).toHaveLength(MAX_RECENT_SEARCHES);
    expect(list[0]).toBe('search 14');
  });

  it('ignores an empty search', () => {
    expect(withRecent(['linen'], '   ')).toEqual(['linen']);
    expect(tidySearch(' \n ')).toBe('');
  });

  it('reads back only what is valid', () => {
    expect(readRecent(undefined)).toEqual([]);
    expect(readRecent('not json')).toEqual([]);
    expect(readRecent('{"a":1}')).toEqual([]);
    expect(readRecent('["linen", 3, "  ", "jeans"]')).toEqual(['linen', 'jeans']);
  });
});
