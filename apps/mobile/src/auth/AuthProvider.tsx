import type { Me } from '@outfitly/shared';
import * as Linking from 'expo-linking';
import * as WebBrowser from 'expo-web-browser';
import { createContext, type ReactNode, useContext, useEffect, useMemo } from 'react';
import { api } from '../api';
import { carryOverLoggedOutData } from '../feed/cache';
import { queryClient } from '../lib/query';
import { forgetLocalSaves, outbox, refreshSavedLists, setGuestSessionStarter } from '../saves';
import { clearRecentSearches } from '../search';
import { forgetTaste } from '../taste';
import { useCaptchaToken } from './captcha';
import { type AuthFlows, createAuthFlows } from './flows';
import { getMe, pendingGuestMerge, setMe } from './store';
import { supabase } from './supabase';

const AuthContext = createContext<AuthFlows | null>(null);

function clearLocalSession(): void {
  setMe(null);
  // Nothing from the previous login may show for the next one, or be sent as it.
  queryClient.clear();
  forgetLocalSaves();
  forgetTaste();
  clearRecentSearches();
}

function signedIn(me: Me): void {
  // Logged out → first login (the first save): what's on screen carries on.
  carryOverLoggedOutData(queryClient, getMe(), me);
  setMe(me);
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
            onSignedIn: signedIn,
            onSignedOut: clearLocalSession,
            hasProfile: () => getMe() !== null,
            pendingMerge: pendingGuestMerge,
            // A save sent as the guest a moment ago lands before the guest's saves move.
            beforeMerge: () => outbox.settled(),
            onMerged: refreshSavedLists,
          })
        : null,
    [getCaptchaToken],
  );

  useEffect(() => {
    if (!supabase || !flows) return;
    // A save waiting on the phone makes the guest session (the first save).
    setGuestSessionStarter(() => flows.ensureSession());
    // A guest merge that couldn't reach our server last time.
    void flows.retryPendingMerge();
    // Session ended elsewhere (expired refresh token, account deleted): forget it here too.
    const { data } = supabase.auth.onAuthStateChange((event) => {
      if (event === 'SIGNED_OUT') clearLocalSession();
    });
    return () => {
      setGuestSessionStarter(null);
      data.subscription.unsubscribe();
    };
  }, [flows]);

  return <AuthContext.Provider value={flows}>{children}</AuthContext.Provider>;
}

export function useAuth(): AuthFlows | null {
  return useContext(AuthContext);
}
