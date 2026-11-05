import { z } from 'zod';
import { type NetworkPolicy, safeFetch } from './fetch.ts';
import type { PageProduct } from './parse.ts';

/**
 * Microlink, a paid page reader with a small free allowance (no key): only a
 * fallback, behind the `link_reader_microlink` feature flag (off), for pages
 * our own reader finds no product on. It gives a name and photo, no price.
 */
export const MICROLINK_FLAG = 'link_reader_microlink';
const ENDPOINT = 'https://api.microlink.io/';

const answerShape = z.object({
  status: z.literal('success'),
  data: z.object({
    title: z.string().nullish(),
    publisher: z.string().nullish(),
    image: z.object({ url: z.string() }).nullish(),
  }),
});

export async function readWithMicrolink(
  pageUrl: string,
  options: { network?: NetworkPolicy; endpoint?: string } = {},
): Promise<PageProduct | null> {
  const { network } = options;
  const request = new URL(options.endpoint ?? ENDPOINT);
  request.searchParams.set('url', pageUrl);
  const answer = await safeFetch(request, {
    accept: 'application/json',
    maxBytes: 512 * 1024,
    overLimit: 'refuse',
    contentTypes: ['application/json'],
    network,
  });
  let body: unknown;
  try {
    body = JSON.parse(answer.body.toString('utf8'));
  } catch {
    return null;
  }
  const parsed = answerShape.safeParse(body);
  if (!parsed.success) return null;
  const name = parsed.data.data.title?.replace(/\s+/g, ' ').trim().slice(0, 300);
  if (!name) return null;
  const image = parsed.data.data.image?.url ?? null;
  return {
    name,
    brand: null,
    gtin: null,
    imageUrl: image && /^https?:\/\//.test(image) ? image : null,
    priceMinor: null,
    currency: null,
    stock: 'unknown',
    source: 'microlink',
  };
}
