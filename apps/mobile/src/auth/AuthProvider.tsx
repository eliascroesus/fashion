import * as Linking from 'expo-linking';
import * as WebBrowser from 'expo-web-browser';
import { createContext, type ReactNode, useContext, useEffect, useMemo } from 'react';
import { api } from '../api';
import { queryClient } from '../lib/query';
import { useCaptchaToken } from './captcha';
import { type AuthFlows, createAuthFlows } from './flows';
import { getMe, pendingGuestMerge, setMe } from './store';
import { supabase } from './supabase';

const AuthContext = createContext<AuthFlows | null>(null);

function clearLocalSession(): void {
  setMe(null);
  // Nothing from the previous login may show for the next one.
  queryClient.clear();
}

/** Gives screens the sign-in actions (null when this build has no Supabase settings). */
export function AuthProvider({ children }: { children: ReactNode }) {
  const getCaptchaToken = useCaptchaToken();
  const flows = useMemo(
    () =>
      supabase
        ? createAuthFlows({
            auth: supabase.auth,
            api: api.session,
            getCaptchaToken,
            redirectTo: Linking.createURL('auth-callback'),
            openAuthSession: async (url, redirectTo) => {
              const result = await WebBrowser.openAuthSessionAsync(url, redirectTo);
              return result.type === 'success' ? result.url : null;
            },
            onSignedIn: setMe,
            onSignedOut: clearLocalSession,
            hasProfile: () => getMe() !== null,
            pendingMerge: pendingGuestMerge,
          })
        : null,
    [getCaptchaToken],
  );

  useEffect(() => {
    if (!supabase || !flows) return;
    // A guest merge that couldn't reach our server last time.
    void flows.retryPendingMerge();
    // Session ended elsewhere (expired refresh token, account deleted): forget it here too.
    const { data } = supabase.auth.onAuthStateChange((event) => {
      if (event === 'SIGNED_OUT') clearLocalSession();
    });
    return () => {
      data.subscription.unsubscribe();
    };
  }, [flows]);

  return <AuthContext.Provider value={flows}>{children}</AuthContext.Provider>;
}

export function useAuth(): AuthFlows | null {
  return useContext(AuthContext);
}
