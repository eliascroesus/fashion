/** Recent searches kept on the phone. */
export const MAX_RECENT_SEARCHES = 10;

/** A search as typed, tidied: spaces trimmed and runs of them made one. Empty: nothing to search. */
export function tidySearch(text: string): string {
  return text.trim().replace(/\s+/g, ' ');
}

/** The recent searches after searching `text`: it comes first, once (ignoring case), at most MAX. */
export function withRecent(list: readonly string[], text: string): string[] {
  const search = tidySearch(text);
  if (!search) return [...list];
  const key = search.toLowerCase();
  return [search, ...list.filter((s) => s.toLowerCase() !== key)].slice(0, MAX_RECENT_SEARCHES);
}

/** Recent searches as stored (anything else, e.g. from an older app version, is dropped). */
export function readRecent(stored: string | undefined): string[] {
  try {
    const value: unknown = JSON.parse(stored ?? '[]');
    if (!Array.isArray(value)) return [];
    return value
      .filter((v): v is string => typeof v === 'string' && tidySearch(v).length > 0)
      .slice(0, MAX_RECENT_SEARCHES);
  } catch {
    return [];
  }
}
