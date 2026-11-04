import { describe, expect, it } from 'vitest';
import {
  LOOK_TAGS,
  MAX_SEARCH_WORDS,
  searchQuerySchema,
  searchWords,
  STOP_WORDS,
  TAG_SEARCH_WORDS,
} from './index.ts';

describe('searchWords', () => {
  it('lowercases and keeps letters and digits of any language', () => {
    expect(searchWords('Linen SHIRT, 90s-jeans!')).toEqual(['linen', 'shirt', '90s', 'jeans']);
    expect(searchWords('Bröllop på hösten')).toEqual(['bröllop', 'hösten']);
  });

  it('keeps each word once and at most MAX_SEARCH_WORDS', () => {
    expect(searchWords('linen Linen linen')).toEqual(['linen']);
    expect(searchWords('a1 b2 c3 d4 e5 f6 g7 h8')).toHaveLength(MAX_SEARCH_WORDS);
  });

  it('leaves out small words unless that is all there is', () => {
    expect(searchWords('shirt with jeans')).toEqual(['shirt', 'jeans']);
    expect(searchWords('skjorta med jeans')).toEqual(['skjorta', 'jeans']);
    expect(searchWords('the')).toEqual(['the']);
  });

  it('finds no words in punctuation (and tsquery syntax never gets through)', () => {
    expect(searchWords("!!! ' & | :* ()")).toEqual([]);
    expect(searchWords("lin'ne & (shirt)")).toEqual(['lin', 'ne', 'shirt']);
  });
});

describe('search words for tags', () => {
  it('are lowercase single words, never a stop word or another tag', () => {
    const tags = new Set<string>(LOOK_TAGS);
    const seen = new Set<string>();
    for (const tag of LOOK_TAGS) {
      for (const word of TAG_SEARCH_WORDS[tag]) {
        expect(searchWords(word)).toEqual([word]);
        expect(STOP_WORDS.has(word)).toBe(false);
        expect(tags.has(word)).toBe(false);
        expect(seen.has(word)).toBe(false);
        seen.add(word);
      }
    }
  });
});

describe('searchQuerySchema', () => {
  it('turns control characters (e.g. NUL, which Postgres refuses) into spaces', () => {
    expect(searchQuerySchema.parse({ q: 'linen\u0000shirt\n' }).q).toBe('linen shirt');
    expect(searchQuerySchema.safeParse({ q: '\u0000\u0007' }).success).toBe(false);
  });

  it('trims and needs 1–100 characters', () => {
    expect(searchQuerySchema.parse({ q: '  linen ' }).q).toBe('linen');
    expect(searchQuerySchema.safeParse({ q: '   ' }).success).toBe(false);
    expect(searchQuerySchema.safeParse({ q: 'x'.repeat(101) }).success).toBe(false);
  });
});
