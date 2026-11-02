import { createClient, type SupabaseClient } from '@supabase/supabase-js';
import { AppState } from 'react-native';
import { storage } from '../lib/storage';

const url = process.env['EXPO_PUBLIC_SUPABASE_URL'];
const publishableKey = process.env['EXPO_PUBLIC_SUPABASE_PUBLISHABLE_KEY'];

/** Login is only available when the build has the Supabase project settings. */
export const authConfigured = Boolean(url && publishableKey);

/**
 * Supabase is used for login only: all data goes through our API. The session
 * is kept in MMKV so people stay signed in between launches.
 */
export const supabase: SupabaseClient | null = authConfigured
  ? createClient(url ?? '', publishableKey ?? '', {
      auth: {
        storage: {
          getItem: (key) => storage.getString(key) ?? null,
          setItem: (key, value) => {
            storage.set(key, value);
          },
          removeItem: (key) => {
            storage.remove(key);
          },
        },
        autoRefreshToken: true,
        persistSession: true,
        detectSessionInUrl: false,
        flowType: 'pkce',
      },
    })
  : null;

// Refresh tokens only while the app is open (Supabase's advice for mobile).
if (supabase) {
  AppState.addEventListener('change', (state) => {
    if (state === 'active') void supabase.auth.startAutoRefresh();
    else void supabase.auth.stopAutoRefresh();
  });
}

export async function getAccessToken(): Promise<string | null> {
  if (!supabase) return null;
  const { data } = await supabase.auth.getSession();
  return data.session?.access_token ?? null;
}
