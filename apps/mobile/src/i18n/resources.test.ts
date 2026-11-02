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

  it('picks the first device language we have, else English', () => {
    expect(pickLanguage(['sv', 'en'])).toBe('sv');
    expect(pickLanguage(['de', 'sv'])).toBe('sv');
    expect(pickLanguage(['de', null])).toBe('en');
  });
});
