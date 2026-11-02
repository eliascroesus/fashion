import * as Linking from 'expo-linking';
import * as WebBrowser from 'expo-web-browser';
import { createContext, type ReactNode, useContext, useMemo } from 'react';
import { api } from '../api';
import { queryClient } from '../lib/query';
import { useCaptchaToken } from './captcha';
import { type AuthFlows, createAuthFlows } from './flows';
import { setMe } from './store';
import { supabase } from './supabase';

const AuthContext = createContext<AuthFlows | null>(null);

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
            onSignedOut: () => {
              setMe(null);
              // Nothing from the previous login may show for the next one.
              queryClient.clear();
            },
          })
        : null,
    [getCaptchaToken],
  );
  return <AuthContext.Provider value={flows}>{children}</AuthContext.Provider>;
}

export function useAuth(): AuthFlows | null {
  return useContext(AuthContext);
}
