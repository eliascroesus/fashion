import { createAsyncStoragePersister } from '@tanstack/query-async-storage-persister';
import { QueryClient } from '@tanstack/react-query';
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
});

export const PERSIST_MAX_AGE = DAY;
