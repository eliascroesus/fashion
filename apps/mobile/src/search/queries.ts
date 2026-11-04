import { keepPreviousData, useQuery } from '@tanstack/react-query';
import { useEffect, useState } from 'react';
import { api } from '../api';
import { useMe } from '../auth/store';
import { type CardList, usePagedCards } from '../feed/card-list';
import { popularQueryKey, searchQueryKey, suggestQueryKey } from './keys';

/** Suggestions are asked for once typing pauses this long. */
const SUGGEST_DELAY_MS = 120;

/** `value`, once it has stayed the same for `ms`. */
function useSettled<T>(value: T, ms: number): T {
  const [settled, setSettled] = useState(value);
  useEffect(() => {
    const timer = setTimeout(() => {
      setSettled(value);
    }, ms);
    return () => {
      clearTimeout(timer);
    };
  }, [value, ms]);
  return settled;
}

/** A search's results, 20 at a time (`text` null: nothing searched yet). */
export function useSearchResults(text: string | null): CardList {
  const profileId = useMe()?.activeProfileId ?? null;
  return usePagedCards(
    searchQueryKey(profileId, text ?? ''),
    (cursor, signal) => api.search.looks(text ?? '', cursor, signal),
    text !== null,
  );
}

/** Suggestions are kept this long for backspacing, and not stored on the phone after that. */
const SUGGEST_CACHE_MS = 5 * 60 * 1000;

/**
 * Suggestions for what's being typed (while `shown`), asked for once typing
 * pauses. The last ones stay on screen while the next load; `forText` says
 * which text they're for.
 */
export function useSuggestions(text: string, shown: boolean) {
  const settled = useSettled(text, SUGGEST_DELAY_MS);
  const query = useQuery({
    queryKey: suggestQueryKey(settled),
    queryFn: ({ signal }) => api.search.suggest(settled, signal),
    enabled: shown && settled.length > 0,
    placeholderData: keepPreviousData,
    staleTime: SUGGEST_CACHE_MS,
    gcTime: SUGGEST_CACHE_MS,
  });
  return {
    data: query.data,
    forText: query.isPlaceholderData ? null : settled,
    isError: query.isError && !query.data,
  };
}

/** The tags most looks carry (search's chips before typing). */
export function usePopularTags() {
  return useQuery({
    queryKey: popularQueryKey,
    queryFn: ({ signal }) => api.search.popular(signal),
    staleTime: 15 * 60 * 1000,
  });
}
