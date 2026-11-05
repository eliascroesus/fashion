import { createAsyncStoragePersister } from '@tanstack/query-async-storage-persister';
import { QueryClient } from '@tanstack/react-query';
import { trimFeedsForStorage } from './persist';
import { shouldRetry } from './query-retry';
import { storage } from './storage';

const DAY = 24 * 60 * 60 * 1000;

export const queryClient = new QueryClient({
  defaultOptions: {
    queries: {
      staleTime: 60 * 1000,
      // Kept long enough that a cold start can show the last feed while refreshing.
      gcTime: DAY,
      retry: shouldRetry,
    },
  },
});

/** Saves the query cache in MMKV so the app opens with the last data, even offline. */
export const queryPersister = createAsyncStoragePersister({
  storage: {
    getItem: (key) => storage.getString(key) ?? null,
    setItem: (key, value) => {
      storage.set(key, value);
    },
    removeItem: (key) => {
      storage.remove(key);
    },
  },
  // Feeds keep only their first pages on the phone, so writing the cache stays quick while scrolling.
  serialize: (client) => JSON.stringify(trimFeedsForStorage(client)),
});

export const PERSIST_MAX_AGE = DAY;

/**
 * Bumped whenever a cached answer's shape changes within one app version, so
 * the phone drops the old cache instead of restoring answers missing fields
 * (2: Step 3.6's look pieces and board totals; 3: Step 3.8's "More like this"
 * and search lists, whose old cursors the server no longer reads).
 */
export const CACHE_SHAPE = 3;
