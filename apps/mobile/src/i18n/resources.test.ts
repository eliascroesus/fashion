import { LOOK_TAGS, STYLES, TAG_SEARCH_WORDS } from '@outfitly/shared';
import { describe, expect, it } from 'vitest';
import { pickLanguage, resources } from './resources';

function keys(value: unknown, prefix = ''): string[] {
  if (typeof value !== 'object' || value === null) return [prefix];
  return Object.entries(value).flatMap(([k, v]) => keys(v, prefix ? `${prefix}.${k}` : k));
}

function leaves(value: unknown): unknown[] {
  if (typeof value !== 'object' || value === null) return [value];
  return Object.values(value).flatMap(leaves);
}

describe('translations', () => {
  const english = keys(resources.en.translation).sort();

  it.each(Object.keys(resources))('%s has exactly the English keys', (language) => {
    const translation = resources[language as keyof typeof resources].translation;
    expect(keys(translation).sort()).toEqual(english);
  });

  it.each(Object.keys(resources))('%s has no empty texts', (language) => {
    const translation = resources[language as keyof typeof resources].translation;
    for (const text of leaves(translation)) {
      expect(typeof text === 'string' && text.trim().length > 0).toBe(true);
    }
  });

  it('names every look style (the taste picker chips)', () => {
    expect(Object.keys(resources.en.translation.styles).sort()).toEqual([...STYLES].sort());
  });

  it('names every occasion and season (search chips)', () => {
    const tags = LOOK_TAGS.filter((tag) => !(STYLES as readonly string[]).includes(tag));
    expect(Object.keys(resources.en.translation.tags).sort()).toEqual([...tags].sort());
  });

  it.each(Object.keys(resources))('%s: searching a tag label finds that tag', (language) => {
    const { styles, tags } = resources[language as keyof typeof resources].translation;
    const labels: Record<string, string> = { ...styles, ...tags };
    for (const tag of LOOK_TAGS) {
      expect([tag, ...TAG_SEARCH_WORDS[tag]]).toContain(labels[tag]?.toLowerCase());
    }
  });

  it('picks the first device language we have, else English', () => {
    expect(pickLanguage(['sv', 'en'])).toBe('sv');
    expect(pickLanguage(['de', 'sv'])).toBe('sv');
    expect(pickLanguage(['de', null])).toBe('en');
  });
});
