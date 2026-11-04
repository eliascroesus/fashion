import { describe, expect, it } from 'vitest';
import { LOOK_TAGS, lookSlug, OCCASIONS, SEASONS, splitLookTags, STYLES } from './index.ts';

const ID = '3f9a2c1b-4d5e-4f60-8a1b-2c3d4e5f6a7b';

describe('look tags', () => {
  it('has no tag in two groups (occasion, season, style)', () => {
    expect(new Set(LOOK_TAGS).size).toBe(OCCASIONS.length + SEASONS.length + STYLES.length);
  });

  it('sorts mixed tags into occasions, seasons and styles, dropping duplicates', () => {
    expect(
      splitLookTags(['autumn', 'streetwear', 'work', 'party', 'autumn', 'winter', 'streetwear']),
    ).toEqual({
      occasions: ['work', 'party'],
      seasons: ['autumn', 'winter'],
      styles: ['streetwear'],
    });
  });
});

describe('lookSlug', () => {
  it('makes readable text from the caption plus 12 characters of the id', () => {
    expect(lookSlug('Camel coat over a grey knit', ID)).toBe(
      'camel-coat-over-a-grey-knit-3f9a2c1b4d5e',
    );
  });

  it('folds Swedish and other accented letters to plain ASCII', () => {
    expect(lookSlug('Höstlook på Söder — æble & straße', ID)).toBe(
      'hostlook-pa-soder-aeble-strasse-3f9a2c1b4d5e',
    );
  });

  it('falls back to "look" when the caption has no usable text', () => {
    expect(lookSlug(null, ID)).toBe('look-3f9a2c1b4d5e');
    expect(lookSlug('🔥🔥🔥', ID)).toBe('look-3f9a2c1b4d5e');
  });

  it('keeps the text part to 60 characters without a trailing dash', () => {
    const slug = lookSlug(`${'word '.repeat(30)}end`, ID);
    const text = slug.slice(0, -13);
    expect(text.length).toBeLessThanOrEqual(60);
    expect(text).not.toMatch(/-$/);
    expect(slug).toMatch(/^[a-z0-9-]+$/);
  });
});
