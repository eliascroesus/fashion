// Pure grid maths for the home feed (no React Native imports, so it's unit-tested).
import { FEED_PAGE_SIZE, type FeedCard, type FeedPage, MEDIA_SIZES } from '@outfitly/shared';

/** A card's photo is shown between these height ÷ width ratios; anything beyond is cropped. */
export const CARD_RATIO = { min: 0.6, max: 1.8 } as const;

/** The next page loads once the user is this far into the newest page. */
export const LOAD_MORE_AT = 0.6;

/** Photos are fetched ahead for this many screens below the last visible card. */
export const PREFETCH_SCREENS = 2;

export interface GridMetrics {
  columns: number;
  /** Space between cards. */
  gap: number;
  /** Space between the cards and the screen edge. */
  inset: number;
}

/** Width of one card's photo on a screen this wide. */
export function cardWidth(screenWidth: number, { columns, gap, inset }: GridMetrics): number {
  return Math.floor((screenWidth - 2 * inset - (columns - 1) * gap) / columns);
}

/** Height of a card's photo: known before it loads, so the grid never jumps. */
export function photoHeight(photo: FeedCard['photo'], width: number): number {
  const ratio = Math.min(CARD_RATIO.max, Math.max(CARD_RATIO.min, photo.height / photo.width));
  return Math.round(width * ratio);
}

/** The smallest stored size that is still sharp at `widthPx` real pixels (the 1080 if none is). */
export function pickPhotoUrl(urls: FeedCard['photo']['urls'], widthPx: number): string {
  const size = [...MEDIA_SIZES].sort((a, b) => a - b).find((s) => s >= widthPx) ?? 1080;
  return urls[size];
}

/**
 * All pages as one list, each look once. A list the server had to restart
 * (gone, or another profile's) can send looks that are already on screen.
 */
export function dedupeCards(pages: readonly FeedPage[]): FeedCard[] {
  const seen = new Set<string>();
  const cards: FeedCard[] = [];
  for (const page of pages) {
    for (const card of page.items) {
      if (seen.has(card.id)) continue;
      seen.add(card.id);
      cards.push(card);
    }
  }
  return cards;
}

/** True once the furthest visible card is LOAD_MORE_AT of the way into the newest page. */
export function shouldLoadMore(
  furthestVisible: number,
  loaded: number,
  pageSize: number = FEED_PAGE_SIZE,
): boolean {
  if (loaded === 0 || furthestVisible < 0) return false;
  return furthestVisible >= loaded - Math.round(pageSize * (1 - LOAD_MORE_AT));
}

export interface PrefetchInput {
  cards: readonly FeedCard[];
  /** Index of the furthest visible card (-1 before anything is on screen). */
  furthestVisible: number;
  viewportHeight: number;
  cardWidth: number;
  /** The card width in real pixels (cardWidth × pixel ratio), to pick the photo size. */
  widthPx: number;
  metrics: GridMetrics;
  /** Photos already asked for; they're skipped. */
  done: ReadonlySet<string>;
}

/**
 * Photo links for the cards after the furthest visible one, enough to fill
 * PREFETCH_SCREENS screens (cards share the height between the columns).
 */
export function photosToPrefetch(input: PrefetchInput): string[] {
  const { cards, furthestVisible, viewportHeight, metrics, done } = input;
  const budget = PREFETCH_SCREENS * viewportHeight * metrics.columns;
  const urls: string[] = [];
  let filled = 0;
  for (let i = furthestVisible + 1; i < cards.length && filled < budget; i++) {
    const card = cards[i];
    if (!card) break;
    filled += photoHeight(card.photo, input.cardWidth) + metrics.gap;
    const url = pickPhotoUrl(card.photo.urls, input.widthPx);
    if (!done.has(url)) urls.push(url);
  }
  return urls;
}
