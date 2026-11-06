import { MAX_LINK_BYTES } from '@outfitly/shared';

/**
 * The two links an offer keeps (see `offers` in packages/db): the poster's link
 * exactly as given (affiliate tags and all: Shop opens it), and the shop's own
 * product page with tracking removed (checks read it, so a check is never a
 * click on someone's affiliate link).
 */

/** Ad, analytics and affiliate-network tags. Only well-known ones: shops use plenty of real parameters. */
const TRACKING_PREFIXES = ['utm_', 'mc_', 'pk_', 'hsa_', '_hs', 'oly_', 'vero_', 'aff_'];
const TRACKING_NAMES = new Set([
  'gclid',
  'gbraid',
  'wbraid',
  'dclid',
  'gclsrc',
  'srsltid',
  '_ga',
  '_gl',
  'fbclid',
  'igsh',
  'igshid',
  'msclkid',
  'ttclid',
  'twclid',
  'li_fat_id',
  'epik',
  'yclid',
  'sc_cid',
  '_kx',
  'mkt_tok',
  's_kwcid',
  'ef_id',
  // Affiliate networks common in the Nordics: Awin, Adtraction, Tradedoubler, CJ, Impact,
  // Rakuten, Partnerize, Zanox.
  'awc',
  'at_gd',
  'tduid',
  'cjevent',
  'cjdata',
  'irclickid',
  'irgwc',
  'ranmid',
  'raneaid',
  'ransiteid',
  'clickref',
  'zanpid',
  'affid',
  'affiliate_id',
]);

function isTracking(name: string): boolean {
  const lower = name.toLowerCase();
  return TRACKING_NAMES.has(lower) || TRACKING_PREFIXES.some((p) => lower.startsWith(p));
}

/** A link as stored: at most MAX_LINK_BYTES. */
export function fitsLinkLimit(url: string): boolean {
  return Buffer.byteLength(url, 'utf8') <= MAX_LINK_BYTES;
}

/**
 * A link at the end of a sentence loses the sentence's punctuation, like chat
 * apps do: "…?aff=x." → "…?aff=x", "(see https://…/p/1)" → "…/p/1", but a
 * closing bracket the link itself opened stays ("…/Coat_(black)").
 */
function withoutTrailingPunctuation(link: string): string {
  let text = link;
  for (;;) {
    const last = text.at(-1) ?? '';
    const pairs: Record<string, string> = { ')': '(', ']': '[', '}': '{' };
    const opener = pairs[last];
    if (opener !== undefined) {
      const opened = text.split(opener).length - 1;
      const closed = text.split(last).length - 1;
      if (closed <= opened) return text;
    } else if (!'.,;:!?\'"*'.includes(last) || last === '') {
      return text;
    }
    text = text.slice(0, -1);
  }
}

/**
 * The link in what someone pasted or shared: the first http(s) link in the
 * text, or the text itself with https added if it looks like `www.shop.se/…`.
 * Nothing in the link itself is changed (URL parsing only normalises spelling,
 * e.g. the host's case), so affiliate tags stay. Null if there's no usable link.
 */
export function linkFromInput(input: string): URL | null {
  const text = input.trim();
  const inText = /https?:\/\/[^\s<>"']+/i.exec(text)?.[0];
  const bare = /^[^\s/:]+\.[a-z]{2,}(\/\S*)?$/i.test(text) ? `https://${text}` : null;
  const found = inText ?? bare;
  if (!found) return null;
  try {
    const url = new URL(withoutTrailingPunctuation(found));
    return url.protocol === 'https:' || url.protocol === 'http:' ? url : null;
  } catch {
    return null;
  }
}

function withoutTracking(url: URL): URL {
  const clean = new URL(url.href);
  clean.hash = '';
  for (const name of [...clean.searchParams.keys()]) {
    if (isTracking(name)) clean.searchParams.delete(name);
  }
  // `searchParams` turns a bare "?" into nothing; keep the rest as the shop wrote it.
  if (clean.search === '?') clean.search = '';
  return clean;
}

/** A shop's site: its host without `www.` or `m.`. */
export function siteOf(host: string): string {
  return host.toLowerCase().replace(/^(www|m)\./, '');
}

/**
 * The shop's product page: its canonical link when that's on the same site,
 * otherwise where the redirects ended; tracking tags and #fragment removed.
 */
export function shopPageUrl(finalUrl: URL, canonicalUrl: string | null): string {
  let page = finalUrl;
  if (canonicalUrl) {
    try {
      const canonical = new URL(canonicalUrl);
      if (siteOf(canonical.hostname) === siteOf(finalUrl.hostname)) page = canonical;
    } catch {
      // Ignore a broken canonical link.
    }
  }
  const clean = withoutTracking(page);
  if (fitsLinkLimit(clean.href)) return clean.href;
  return `${clean.origin}${clean.pathname}`.slice(0, MAX_LINK_BYTES);
}
