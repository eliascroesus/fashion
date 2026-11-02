import type { Me } from '@outfitly/shared';
import type { SupabaseClient } from '@supabase/supabase-js';

/** The parts of Supabase Auth the flows use (tests pass a fake). */
export type AuthClient = Pick<
  SupabaseClient['auth'],
  | 'getSession'
  | 'refreshSession'
  | 'signInAnonymously'
  | 'signInWithIdToken'
  | 'signInWithOtp'
  | 'signInWithOAuth'
  | 'linkIdentity'
  | 'updateUser'
  | 'verifyOtp'
  | 'exchangeCodeForSession'
  | 'signOut'
>;

export interface SessionApi {
  /** POST /v1/session: makes sure the login has its personal profile. */
  start: () => Promise<Me>;
  /** POST /v1/session/merge-guest: moves a guest's content into this account. */
  mergeGuest: (guestAccessToken: string) => Promise<unknown>;
}

export interface FlowDeps {
  auth: AuthClient;
  api: SessionApi;
  /** A CAPTCHA token for anonymous and email sign-ins (undefined when CAPTCHA is off). */
  getCaptchaToken: () => Promise<string | undefined>;
  /** Opens a sign-in page in the system browser; resolves with the URL it came back to. */
  openAuthSession: (url: string, redirectTo: string) => Promise<string | null>;
  redirectTo: string;
  onSignedIn: (me: Me) => void;
  onSignedOut: () => void;
}

export class AuthFlowError extends Error {
  readonly code: string;
  constructor(code: string, message?: string) {
    super(message ?? code);
    this.name = 'AuthFlowError';
    this.code = code;
  }
}

/** How a sign-in ended: a guest kept their account, merged into an existing one, or a plain sign-in. */
export type SignInResult = 'upgraded' | 'merged' | 'signed_in' | 'cancelled';

/** Where an email code goes: confirm the guest's new email, or sign in to an account. */
export type EmailMode = 'link' | 'existing' | 'new';

function fail(error: { code?: string | undefined; message: string } | null): void {
  if (error) throw new AuthFlowError(error.code ?? 'auth_error', error.message);
}

export function createAuthFlows(deps: FlowDeps) {
  const { auth, api } = deps;
  /** Set while an email sign-in that started from a guest session is in progress. */
  let pendingGuestToken: string | null = null;

  async function currentSession() {
    const { data, error } = await auth.getSession();
    fail(error);
    return data.session;
  }

  async function finish(result: Exclude<SignInResult, 'cancelled'>, guestToken?: string | null) {
    const me = await api.start();
    if (guestToken) await api.mergeGuest(guestToken);
    deps.onSignedIn(me);
    return result;
  }

  return {
    /**
     * A session to save with: the current one, or a new guest session. Call
     * this only when someone first saves something, never at app open.
     */
    async ensureSession(): Promise<Me | null> {
      if (await currentSession()) return null;
      const captchaToken = await deps.getCaptchaToken();
      const { error } = await auth.signInAnonymously({ options: { captchaToken } });
      fail(error);
      const me = await api.start();
      deps.onSignedIn(me);
      return me;
    },

    /**
     * Native Apple sign-in (or any provider that gives an ID token). A guest is
     * upgraded in place (same user id, same data); if that Apple ID already has
     * an account, we sign in to it and move the guest's content over.
     */
    async signInWithIdToken(provider: 'apple' | 'google', token: string, nonce?: string) {
      const credentials = { provider, token, ...(nonce ? { nonce } : {}) };
      const session = await currentSession();
      if (session?.user.is_anonymous) {
        const linked = await auth.linkIdentity(credentials);
        if (!linked.error) {
          fail((await auth.refreshSession()).error);
          return finish('upgraded');
        }
        if (linked.error.code !== 'identity_already_exists') fail(linked.error);
        const guestToken = session.access_token;
        fail((await auth.signInWithIdToken(credentials)).error);
        return finish('merged', guestToken);
      }
      fail((await auth.signInWithIdToken(credentials)).error);
      return finish('signed_in');
    },

    /** Google (web sign-in page in the system browser), with the same guest rules as Apple. */
    async signInWithGoogle(): Promise<SignInResult> {
      const options = { redirectTo: deps.redirectTo, skipBrowserRedirect: true };
      const session = await currentSession();

      const runOAuth = async (
        start: () => Promise<{
          data: { url: string | null } | null;
          error: { code?: string | undefined; message: string } | null;
        }>,
      ) => {
        const { data, error } = await start();
        fail(error);
        if (!data?.url) throw new AuthFlowError('no_url');
        const returned = await deps.openAuthSession(data.url, deps.redirectTo);
        if (!returned) return { cancelled: true as const };
        const params = new URL(returned.replace('#', '?')).searchParams;
        const code = params.get('code');
        return { cancelled: false as const, code, errorCode: params.get('error_code') };
      };

      if (session?.user.is_anonymous) {
        const linked = await runOAuth(() => auth.linkIdentity({ provider: 'google', options }));
        if (linked.cancelled) return 'cancelled';
        if (linked.code) {
          fail((await auth.exchangeCodeForSession(linked.code)).error);
          fail((await auth.refreshSession()).error);
          return finish('upgraded');
        }
        if (linked.errorCode !== 'identity_already_exists') {
          throw new AuthFlowError(linked.errorCode ?? 'oauth_failed');
        }
      }
      const guestToken = session?.user.is_anonymous ? session.access_token : null;
      const signedIn = await runOAuth(() => auth.signInWithOAuth({ provider: 'google', options }));
      if (signedIn.cancelled) return 'cancelled';
      if (!signedIn.code) throw new AuthFlowError(signedIn.errorCode ?? 'oauth_failed');
      fail((await auth.exchangeCodeForSession(signedIn.code)).error);
      return finish(guestToken ? 'merged' : 'signed_in', guestToken);
    },

    /** Step 1 of email sign-in: send a 6-digit code. */
    async startEmail(email: string): Promise<EmailMode> {
      const session = await currentSession();
      pendingGuestToken = null;
      if (session?.user.is_anonymous) {
        // Give the guest account this email (keeps the same user id)…
        const { error } = await auth.updateUser({ email });
        if (!error) return 'link';
        if (error.code !== 'email_exists') fail(error);
        // …unless the email already has an account: sign in to that one instead.
        pendingGuestToken = session.access_token;
        const captchaToken = await deps.getCaptchaToken();
        fail(
          (await auth.signInWithOtp({ email, options: { shouldCreateUser: false, captchaToken } }))
            .error,
        );
        return 'existing';
      }
      const captchaToken = await deps.getCaptchaToken();
      fail(
        (await auth.signInWithOtp({ email, options: { shouldCreateUser: true, captchaToken } }))
          .error,
      );
      return 'new';
    },

    /** Step 2 of email sign-in: check the code. */
    async verifyEmail(email: string, code: string, mode: EmailMode): Promise<SignInResult> {
      const type = mode === 'link' ? 'email_change' : 'email';
      fail((await auth.verifyOtp({ email, token: code, type })).error);
      if (mode === 'link') {
        fail((await auth.refreshSession()).error);
        return finish('upgraded');
      }
      const guestToken = pendingGuestToken;
      pendingGuestToken = null;
      return finish(guestToken ? 'merged' : 'signed_in', guestToken);
    },

    async signOut(): Promise<void> {
      fail((await auth.signOut()).error);
      deps.onSignedOut();
    },
  };
}

export type AuthFlows = ReturnType<typeof createAuthFlows>;
