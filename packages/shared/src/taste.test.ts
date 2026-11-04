import { describe, expect, it } from 'vitest';
import { BRAND_IDS, BRANDS, forYouQuerySchema, stylesParam, tasteSchema } from './index.ts';

describe('taste', () => {
  it('has each brand once, with an id safe to store', () => {
    expect(new Set(BRAND_IDS).size).toBe(BRANDS.length);
    for (const id of BRAND_IDS) expect(id).toMatch(/^[a-z0-9-]+$/);
  });

  it('keeps each style and brand once, in list order', () => {
    expect(
      tasteSchema.parse({
        styles: ['edgy', 'minimal', 'edgy'],
        brands: ['zara', 'cos', 'zara'],
      }),
    ).toEqual({ styles: ['minimal', 'edgy'], brands: ['cos', 'zara'] });
  });

  it('refuses unknown styles and brands in a saved taste', () => {
    expect(tasteSchema.safeParse({ styles: ['goth'], brands: [] }).success).toBe(false);
    expect(tasteSchema.safeParse({ styles: [], brands: ['gucci'] }).success).toBe(false);
  });
});

describe('For You styles', () => {
  it('reads ?styles= as known styles in list order, dropping unknown ones', () => {
    expect(forYouQuerySchema.parse({ styles: 'edgy,goth,minimal,edgy' }).styles).toEqual([
      'minimal',
      'edgy',
    ]);
    expect(forYouQuerySchema.parse({}).styles).toEqual([]);
  });

  it('writes the param the same way, and leaves it out when there are no styles', () => {
    expect(stylesParam(['edgy', 'minimal'])).toBe('minimal,edgy');
    expect(stylesParam([])).toBeUndefined();
  });
});
