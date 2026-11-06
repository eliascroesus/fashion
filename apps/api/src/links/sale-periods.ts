const DAY_MS = 24 * 60 * 60 * 1000;

/** Black Friday: the day after the fourth Thursday of November (UTC date). */
export function blackFriday(year: number): Date {
  const firstOfNovember = new Date(Date.UTC(year, 10, 1));
  const firstThursday = 1 + ((4 - firstOfNovember.getUTCDay() + 7) % 7);
  return new Date(Date.UTC(year, 10, firstThursday + 22));
}

/**
 * Whether `at` falls in one of the big sale periods of Nordic fashion shops,
 * when prices change from one day to the next: Black Week (the week before
 * Black Friday) to Cyber Monday, Singles' Day (11 November), the Christmas and
 * January sales (20 December to 15 January, "mellandagsrea") and the summer
 * sale (15 June to 15 July). The price check reads pages daily then, and every
 * few days otherwise (Elias, 2026-11-06). UTC dates: a few hours either side
 * don't matter.
 */
export function inSalePeriod(at: Date): boolean {
  const year = at.getUTCFullYear();
  const day = Date.UTC(year, at.getUTCMonth(), at.getUTCDate());
  const friday = blackFriday(year).getTime();
  if (day >= friday - 7 * DAY_MS && day <= friday + 3 * DAY_MS) return true;
  const monthDay = (at.getUTCMonth() + 1) * 100 + at.getUTCDate();
  return (
    monthDay === 1111 || monthDay >= 1220 || monthDay <= 115 || (monthDay >= 615 && monthDay <= 715)
  );
}
