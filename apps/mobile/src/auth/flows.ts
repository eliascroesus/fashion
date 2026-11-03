import type { Me } from '@outfitly/shared';
import type { SupabaseClient } from '@supabase/supabase-js';

/** The parts of Supabase Auth the flows use (tests pass a fake). */
export type AuthClient = Pick<
  SupabaseClient['auth'],
  | 'getSession'
  | 'signInAnonymously'
  | 'signInWithIdToken'
  | 'signInWithOtp'
  | 'signInWithPassword'
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
  /** Whether the app already has this login's profile (from POST /v1/session). */
  hasProfile: () => boolean;
  /** A guest token whose content still has to move into the signed-in account (kept on the phone). */
  pendingMerge: { get: () => string | null; set: (token: string | null) => void };
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
  /** One guest sign-in at a time, however many saves happen at once. */
  let ensuring: Promise<Me | null> | null = null;

  async function currentSession() {
    const { data, error } = await auth.getSession();
    fail(error);
    return data.session;
  }

  /**
   * The session a sign-in starts from. A guest session still being made (the
   * first save, a moment ago) is finished first, so its saves move along and
   * its profile can't replace the account's afterwards.
   */
  async function startingSession() {
    if (ensuring) await ensuring.catch(() => null);
    return currentSession();
  }

  /**
   * Moves a guest's content into the signed-in account. Never throws: the
   * sign-in already worked. Kept for a retry if our server was unreachable;
   * dropped if the server says it can never work (e.g. the guest token expired).
   */
  async function mergePending(): Promise<void> {
    const token = deps.pendingMerge.get();
    if (!token) return;
    try {
      await api.mergeGuest(token);
      deps.pendingMerge.set(null);
    } catch (error) {
      const status = (error as { status?: unknown }).status;
      if (typeof status === 'number' && status >= 400 && status < 500) deps.pendingMerge.set(null);
    }
  }

  async function finish(result: Exclude<SignInResult, 'cancelled'>, guestToken?: string | null) {
    const me = await api.start();
    // Store the new login first, so the merge request acts as the account's profile.
    deps.onSignedIn(me);
    if (guestToken) {
      deps.pendingMerge.set(guestToken);
      await mergePending();
    }
    return result;
  }

  return {
    /**
     * A session to save with: the current one, or a new guest session. Call
     * this only when someone first saves something, never at app open.
     */
    async ensureSession(): Promise<Me | null> {
      ensuring ??= (async () => {
        if (!(await currentSession())) {
          const captchaToken = await deps.getCaptchaToken();
          fail((await auth.signInAnonymously({ options: { captchaToken } })).error);
        } else if (deps.hasProfile()) {
          return null;
        }
        // New guest, or a session whose profile setup didn't finish last time.
        const me = await api.start();
        deps.onSignedIn(me);
        return me;
      })().finally(() => {
        ensuring = null;
      });
      return ensuring;
    },

    /** Finishes a guest merge that couldn't reach our server earlier (call at app start). */
    retryPendingMerge: mergePending,

    /**
     * Native Apple sign-in (or any provider that gives an ID token). A guest is
     * upgraded in place (same user id, same data); if that Apple ID already has
     * an account, we sign in to it and move the guest's content over.
     */
    async signInWithIdToken(provider: 'apple' | 'google', token: string, nonce?: string) {
      const credentials = { provider, token, ...(nonce ? { nonce } : {}) };
      const session = await startingSession();
      if (session?.user.is_anonymous) {
        // Linking returns a fresh session in which the user is no longer anonymous.
        const linked = await auth.linkIdentity(credentials);
        if (!linked.error) return finish('upgraded');
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
      const session = await startingSession();

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
        // Supabase puts results in the query (?code=) and errors in the query or the fragment.
        const url = new URL(returned);
        const fragment = new URLSearchParams(url.hash.slice(1));
        const read = (key: string) => url.searchParams.get(key) ?? fragment.get(key);
        return { cancelled: false as const, code: read('code'), errorCode: read('error_code') };
      };

      if (session?.user.is_anonymous) {
        const linked = await runOAuth(() => auth.linkIdentity({ provider: 'google', options }));
        if (linked.cancelled) return 'cancelled';
        if (linked.code) {
          fail((await auth.exchangeCodeForSession(linked.code)).error);
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

    /**
     * Email + password, for the automated tests' test login only (the
     * developer menu; people use Apple, Google or an emailed code). Same guest
     * rules as the others: a guest's content moves into the account.
     */
    async signInWithPassword(email: string, password: string): Promise<SignInResult> {
      const session = await startingSession();
      const guestToken = session?.user.is_anonymous ? session.access_token : null;
      const captchaToken = await deps.getCaptchaToken();
      fail((await auth.signInWithPassword({ email, password, options: { captchaToken } })).error);
      return finish(guestToken ? 'merged' : 'signed_in', guestToken);
    },

    /** Step 1 of email sign-in: send a 6-digit code. */
    async startEmail(email: string): Promise<EmailMode> {
      const session = await startingSession();
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
      if (mode === 'link') return finish('upgraded');
      const guestToken = pendingGuestToken;
      pendingGuestToken = null;
      return finish(guestToken ? 'merged' : 'signed_in', guestToken);
    },

    /**
     * Signs out on this phone only (other phones stay signed in). The local
     * session is removed even if the server can't be reached.
     */
    async signOut(): Promise<void> {
      try {
        await auth.signOut({ scope: 'local' });
      } finally {
        deps.onSignedOut();
      }
    },
  };
}

export type AuthFlows = ReturnType<typeof createAuthFlows>;
