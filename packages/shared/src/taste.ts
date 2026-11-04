import { z } from 'zod';
import { feedCardSchema } from './feed.ts';
import { STYLES } from './looks.ts';

/**
 * Brands to pick in the taste picker (popular in Sweden). Names are the brands'
 * own, not translated. Saved now; the feed uses them once looks have products
 * (Phase 3). The ids are permanent: add new ones but never rename.
 */
export const BRANDS = [
  { id: 'cos', name: 'COS' },
  { id: 'arket', name: 'Arket' },
  { id: 'weekday', name: 'Weekday' },
  { id: 'other-stories', name: '& Other Stories' },
  { id: 'hm', name: 'H&M' },
  { id: 'zara', name: 'Zara' },
  { id: 'mango', name: 'Mango' },
  { id: 'massimo-dutti', name: 'Massimo Dutti' },
  { id: 'uniqlo', name: 'Uniqlo' },
  { id: 'acne-studios', name: 'Acne Studios' },
  { id: 'filippa-k', name: 'Filippa K' },
  { id: 'our-legacy', name: 'Our Legacy' },
  { id: 'samsoe-samsoe', name: 'Samsøe Samsøe' },
  { id: 'gina-tricot', name: 'Gina Tricot' },
  { id: 'na-kd', name: 'NA-KD' },
  { id: 'nike', name: 'Nike' },
  { id: 'adidas', name: 'Adidas' },
  { id: 'new-balance', name: 'New Balance' },
  { id: 'levis', name: "Levi's" },
  { id: 'carhartt-wip', name: 'Carhartt WIP' },
] as const;
export type BrandId = (typeof BRANDS)[number]['id'];
export const BRAND_IDS = BRANDS.map((brand) => brand.id) as [BrandId, ...BrandId[]];

/** `PUT /v1/taste` body and response: the styles and brands picked (each once). */
export const tasteSchema = z.object({
  styles: z
    .array(z.enum(STYLES))
    .max(STYLES.length)
    .transform((styles) => STYLES.filter((style) => styles.includes(style))),
  brands: z
    .array(z.enum(BRAND_IDS))
    .max(BRANDS.length)
    .transform((brands) => BRAND_IDS.filter((brand) => brands.includes(brand))),
});
export type Taste = z.infer<typeof tasteSchema>;

/** `GET /v1/taste/picker`: looks to swipe in the taste picker, each with its styles. */
export const tastePickerSchema = z.object({
  items: z.array(z.object({ card: feedCardSchema, styles: z.array(z.enum(STYLES)) })),
});
export type TastePicker = z.infer<typeof tastePickerSchema>;
