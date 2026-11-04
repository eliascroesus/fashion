import { type Db, eq, sql, tasteProfiles } from '@outfitly/db';
import { BRAND_IDS, knownStyles, type Taste, type TastePicker } from '@outfitly/shared';
import { type FeedDeps, loadCards, showableLook } from './feed/cards.ts';

/** Looks to swipe in the taste picker. */
export const PICKER_LOOKS = 10;

/**
 * Stores the taste picked on the phone, for a profile that has none yet, and
 * returns what the profile has now. Same rule as a guest merge: a taste already
 * there (e.g. an account signed in to from a phone that picked while logged
 * out) wins. Changing it later is a separate edit (Later).
 */
export async function saveTaste(db: Db, profileId: string, taste: Taste): Promise<Taste> {
  // Nothing picked stores nothing, so it never blocks real picks later.
  if (taste.styles.length > 0 || taste.brands.length > 0) {
    await db
      .insert(tasteProfiles)
      .values({ profileId, styles: taste.styles, brands: taste.brands })
      .onConflictDoNothing({ target: tasteProfiles.profileId });
  }
  const [stored] = await db
    .select({ styles: tasteProfiles.styles, brands: tasteProfiles.brands })
    .from(tasteProfiles)
    .where(eq(tasteProfiles.profileId, profileId));
  return {
    styles: knownStyles(stored?.styles ?? []),
    brands: BRAND_IDS.filter((brand) => stored?.brands.includes(brand)),
  };
}

/**
 * The taste picker's looks: the most popular look in each style first, then
 * each style's next most popular, up to PICKER_LOOKS (each look once).
 */
export async function pickerLooks(deps: FeedDeps): Promise<TastePicker> {
  const { rows } = await deps.db.execute<{ id: string; styles: string[] }>(sql`
    SELECT id, styles FROM (
      SELECT l.id, l.style_tags::text[] AS styles, l.popularity_score,
             row_number() OVER (PARTITION BY s.style
                                ORDER BY l.popularity_score DESC, l.published_at DESC, l.id DESC) AS rank
        FROM looks l, unnest(l.style_tags) AS s(style)
       WHERE ${showableLook(sql`l`)} AND l.published_at <= now()
    ) ranked
    ORDER BY rank, popularity_score DESC, id
    LIMIT ${PICKER_LOOKS * 3}`);
  const stylesOf = new Map<string, string[]>();
  for (const row of rows) {
    if (stylesOf.size === PICKER_LOOKS) break;
    if (!stylesOf.has(row.id)) stylesOf.set(row.id, row.styles);
  }
  const cards = await loadCards(deps, [...stylesOf.keys()], null);
  return {
    items: [...stylesOf].flatMap(([id, styles]) => {
      const card = cards.get(id);
      return card ? [{ card, styles: knownStyles(styles) }] : [];
    }),
  };
}
