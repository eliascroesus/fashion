import type { SimilarPiece, SimilarPiecesPage } from '@outfitly/shared';

/**
 * The pieces of every page loaded so far, in order, each product once (a
 * product can come again on a later page if the catalogue changed meanwhile).
 */
export function uniquePieces(pages: readonly SimilarPiecesPage[]): SimilarPiece[] {
  const seen = new Set<string>();
  const all: SimilarPiece[] = [];
  for (const page of pages) {
    for (const piece of page.items) {
      if (seen.has(piece.productId)) continue;
      seen.add(piece.productId);
      all.push(piece);
    }
  }
  return all;
}
