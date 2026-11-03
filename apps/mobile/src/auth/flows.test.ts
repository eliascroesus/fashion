import type { Me } from '@outfitly/shared';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { type AuthClient, createAuthFlows, type FlowDeps } from './flows';

const ME: Me = { userId: 'u-1', isAnonymous: false, activeProfileId: 'p-1', profiles: [] };
const ok = (data: unknown = {}) => Promise.resolve({ data, error: null });
const err = (code: string) => Promise.resolve({ data: {}, error: { code, message: code } });

/** A fake Supabase Auth: tests set the current session and the answers. */
function fakeAuth() {
  let session: { access_token: string; user: { is_anonymous: boolean } } | null = null;
  const auth = {
    getSession: vi.fn(() => ok({ session })),
    signInAnonymously: vi.fn(() => {
      session = { access_token: 'guest-token', user: { is_anonymous: true } };
      return ok();
    }),
    signInWithIdToken: vi.fn(() => {
      session = { access_token: 'real-token', user: { is_anonymous: false } };
      return ok();
    }),
    linkIdentity: vi.fn((): Promise<unknown> => ok()),
    signInWithOAuth: vi.fn(() => ok({ url: 'https://supabase.test/authorize?google' })),
    exchangeCodeForSession: vi.fn(() => ok()),
    signInWithOtp: vi.fn(() => ok()),
    signInWithPassword: vi.fn((): Promise<unknown> => {
      session = { access_token: 'real-token', user: { is_anonymous: false } };
      return ok();
    }),
    updateUser: vi.fn((): Promise<unknown> => ok()),
    verifyOtp: vi.fn(() => ok()),
    signOut: vi.fn((): Promise<unknown> => {
      session = null;
      return ok();
    }),
  };
  return {
    auth,
    setSession: (s: typeof session) => {
      session = s;
    },
  };
}

const guest = { access_token: 'guest-token', user: { is_anonymous: true } };

let fake: ReturnType<typeof fakeAuth>;
let api: {
  start: ReturnType<typeof vi.fn<() => Promise<Me>>>;
  mergeGuest: ReturnType<typeof vi.fn<(token: string) => Promise<unknown>>>;
};
let deps: FlowDeps;
let pending: string | null;
let hasProfile: boolean;

beforeEach(() => {
  fake = fakeAuth();
  pending = null;
  hasProfile = false;
  api = {
    start: vi.fn(() => Promise.resolve(ME)),
    mergeGuest: vi.fn(() => Promise.resolve({} as unknown)),
  };
  deps = {
    auth: fake.auth as unknown as AuthClient,
    api,
    getCaptchaToken: () => Promise.resolve('captcha-ok'),
    openAuthSession: vi.fn(() => Promise.resolve('outfitly://auth-callback?code=abc')),
    redirectTo: 'outfitly://auth-callback',
    onSignedIn: vi.fn(),
    onSignedOut: vi.fn(),
    hasProfile: () => hasProfile,
    pendingMerge: {
      get: () => pending,
      set: (token) => {
        pending = token;
      },
    },
  };
});

/** The guest's data moved, and only after the new login was stored (so it acts as the account). */
function expectMergedAfterSignIn() {
  expect(api.mergeGuest).toHaveBeenCalledWith('guest-token');
  const signedIn = vi.mocked(deps.onSignedIn).mock.invocationCallOrder[0] ?? Infinity;
  const merged = api.mergeGuest.mock.invocationCallOrder[0] ?? -Infinity;
  expect(signedIn).toBeLessThan(merged);
  expect(pending).toBeNull();
}

describe('ensureSession (first save)', () => {
  it('creates a guest session with a CAPTCHA token and a profile', async () => {
    await createAuthFlows(deps).ensureSession();
    expect(fake.auth.signInAnonymously).toHaveBeenCalledWith({
      options: { captchaToken: 'captcha-ok' },
    });
    expect(api.start).toHaveBeenCalledOnce();
    expect(deps.onSignedIn).toHaveBeenCalledWith(ME);
  });

  it('does nothing when there is already a session with a profile', async () => {
    fake.setSession(guest);
    hasProfile = true;
    await createAuthFlows(deps).ensureSession();
    expect(fake.auth.signInAnonymously).not.toHaveBeenCalled();
    expect(api.start).not.toHaveBeenCalled();
  });

  it('finishes the profile setup if it failed last time', async () => {
    fake.setSession(guest);
    await createAuthFlows(deps).ensureSession();
    expect(fake.auth.signInAnonymously).not.toHaveBeenCalled();
    expect(api.start).toHaveBeenCalledOnce();
  });

  it('makes only one guest when several saves happen at once', async () => {
    const flows = createAuthFlows(deps);
    await Promise.all([flows.ensureSession(), flows.ensureSession(), flows.ensureSession()]);
    expect(fake.auth.signInAnonymously).toHaveBeenCalledOnce();
  });
});

describe('Sign in with Apple', () => {
  it('upgrades a guest in place (same account, so the data stays)', async () => {
    fake.setSession(guest);
    const result = await createAuthFlows(deps).signInWithIdToken('apple', 'apple-id', 'nonce');
    expect(result).toBe('upgraded');
    expect(fake.auth.linkIdentity).toHaveBeenCalledWith({
      provider: 'apple',
      token: 'apple-id',
      nonce: 'nonce',
    });
    expect(fake.auth.signInWithIdToken).not.toHaveBeenCalled();
    expect(api.mergeGuest).not.toHaveBeenCalled();
  });

  it('signs in to the existing account and moves the guest data when the Apple ID is taken', async () => {
    fake.setSession(guest);
    fake.auth.linkIdentity.mockImplementationOnce(() => err('identity_already_exists'));
    const result = await createAuthFlows(deps).signInWithIdToken('apple', 'apple-id');
    expect(result).toBe('merged');
    expect(fake.auth.signInWithIdToken).toHaveBeenCalled();
    expectMergedAfterSignIn();
  });

  it('keeps the guest token when our server is unreachable, and retries later', async () => {
    fake.setSession(guest);
    fake.auth.linkIdentity.mockImplementationOnce(() => err('identity_already_exists'));
    api.mergeGuest.mockRejectedValueOnce(Object.assign(new Error('offline'), { status: 0 }));
    const flows = createAuthFlows(deps);
    expect(await flows.signInWithIdToken('apple', 't')).toBe('merged');
    expect(pending).toBe('guest-token');
    await flows.retryPendingMerge();
    expect(pending).toBeNull();
    expect(api.mergeGuest).toHaveBeenCalledTimes(2);
  });

  it('drops the guest token when the server says it can never merge (e.g. expired)', async () => {
    fake.setSession(guest);
    fake.auth.linkIdentity.mockImplementationOnce(() => err('identity_already_exists'));
    api.mergeGuest.mockRejectedValueOnce(Object.assign(new Error('bad'), { status: 400 }));
    expect(await createAuthFlows(deps).signInWithIdToken('apple', 't')).toBe('merged');
    expect(pending).toBeNull();
  });

  it('surfaces other linking errors', async () => {
    fake.setSession(guest);
    fake.auth.linkIdentity.mockImplementationOnce(() => err('manual_linking_disabled'));
    await expect(createAuthFlows(deps).signInWithIdToken('apple', 't')).rejects.toMatchObject({
      code: 'manual_linking_disabled',
    });
  });

  it('just signs in when there is no guest', async () => {
    expect(await createAuthFlows(deps).signInWithIdToken('apple', 't')).toBe('signed_in');
    expect(fake.auth.linkIdentity).not.toHaveBeenCalled();
  });
});

describe('Google', () => {
  it('links Google to a guest through the browser', async () => {
    fake.setSession(guest);
    fake.auth.linkIdentity.mockImplementationOnce(() => ok({ url: 'https://supabase.test/link' }));
    expect(await createAuthFlows(deps).signInWithGoogle()).toBe('upgraded');
    expect(fake.auth.exchangeCodeForSession).toHaveBeenCalledWith('abc');
  });

  it('falls back to signing in and merging when that Google account exists', async () => {
    fake.setSession(guest);
    fake.auth.linkIdentity.mockImplementationOnce(() => ok({ url: 'https://supabase.test/link' }));
    vi.mocked(deps.openAuthSession)
      .mockResolvedValueOnce(
        'outfitly://auth-callback?error=x#error=x&error_description=Identity+exists&error_code=identity_already_exists',
      )
      .mockResolvedValueOnce('outfitly://auth-callback?code=def');
    expect(await createAuthFlows(deps).signInWithGoogle()).toBe('merged');
    expect(fake.auth.exchangeCodeForSession).toHaveBeenCalledWith('def');
    expectMergedAfterSignIn();
  });

  it('reports a closed browser as cancelled', async () => {
    vi.mocked(deps.openAuthSession).mockResolvedValueOnce(null);
    expect(await createAuthFlows(deps).signInWithGoogle()).toBe('cancelled');
    expect(deps.onSignedIn).not.toHaveBeenCalled();
  });
});

describe('email code', () => {
  it('adds the email to a guest account (same user id)', async () => {
    fake.setSession(guest);
    const flows = createAuthFlows(deps);
    expect(await flows.startEmail('anna@example.com')).toBe('link');
    expect(await flows.verifyEmail('anna@example.com', '123456', 'link')).toBe('upgraded');
    expect(fake.auth.verifyOtp).toHaveBeenCalledWith({
      email: 'anna@example.com',
      token: '123456',
      type: 'email_change',
    });
  });

  it('signs in to the existing account and merges when the email is taken', async () => {
    fake.setSession(guest);
    fake.auth.updateUser.mockImplementationOnce(() => err('email_exists'));
    const flows = createAuthFlows(deps);
    expect(await flows.startEmail('anna@example.com')).toBe('existing');
    expect(fake.auth.signInWithOtp).toHaveBeenCalledWith({
      email: 'anna@example.com',
      options: { shouldCreateUser: false, captchaToken: 'captcha-ok' },
    });
    expect(await flows.verifyEmail('anna@example.com', '123456', 'existing')).toBe('merged');
    expectMergedAfterSignIn();
  });

  it('signs in (or up) without a guest', async () => {
    const flows = createAuthFlows(deps);
    expect(await flows.startEmail('new@example.com')).toBe('new');
    expect(await flows.verifyEmail('new@example.com', '654321', 'new')).toBe('signed_in');
    expect(api.mergeGuest).not.toHaveBeenCalled();
  });
});

describe('sign out', () => {
  it('ends the session on this phone only and clears local state', async () => {
    fake.setSession({ access_token: 'real', user: { is_anonymous: false } });
    await createAuthFlows(deps).signOut();
    expect(fake.auth.signOut).toHaveBeenCalledWith({ scope: 'local' });
    expect(deps.onSignedOut).toHaveBeenCalled();
  });

  it('still clears local state when offline', async () => {
    fake.auth.signOut.mockImplementationOnce(() => Promise.reject(new Error('offline')));
    await expect(createAuthFlows(deps).signOut()).rejects.toThrow('offline');
    expect(deps.onSignedOut).toHaveBeenCalled();
  });
});

describe('sign-in right after the first save', () => {
  it('waits for the guest session being made, then moves its content to the account', async () => {
    const flows = createAuthFlows(deps);
    // The guest's profile setup is still on its way when Apple sign-in starts.
    let finishGuest = () => undefined as unknown;
    api.start.mockImplementationOnce(
      () =>
        new Promise<Me>((resolve) => {
          finishGuest = () => {
            resolve({ ...ME, isAnonymous: true, activeProfileId: 'guest-profile' });
          };
        }),
    );
    void flows.ensureSession();
    fake.auth.linkIdentity.mockImplementationOnce(() => err('identity_already_exists'));
    const signIn = flows.signInWithIdToken('apple', 'apple-token');
    await vi.waitFor(() => {
      expect(api.start).toHaveBeenCalledOnce();
    });
    expect(fake.auth.linkIdentity).not.toHaveBeenCalled();
    finishGuest();
    expect(await signIn).toBe('merged');
    expectMergedAfterSignIn();
    // The account's login is stored last, so the guest's can't replace it.
    expect(vi.mocked(deps.onSignedIn).mock.calls.at(-1)?.[0]).toEqual(ME);
  });
});

describe('password sign-in (test login, developer menu only)', () => {
  it("signs in with a CAPTCHA token and moves a guest's content over", async () => {
    fake.setSession(guest);
    const result = await createAuthFlows(deps).signInWithPassword('test@example.com', 'pw');
    expect(result).toBe('merged');
    expect(fake.auth.signInWithPassword).toHaveBeenCalledWith({
      email: 'test@example.com',
      password: 'pw',
      options: { captchaToken: 'captcha-ok' },
    });
    expectMergedAfterSignIn();
  });

  it('is a plain sign-in without a guest session, and reports a wrong password', async () => {
    const flows = createAuthFlows(deps);
    expect(await flows.signInWithPassword('test@example.com', 'pw')).toBe('signed_in');
    expect(api.mergeGuest).not.toHaveBeenCalled();
    fake.auth.signInWithPassword.mockImplementationOnce(() => err('invalid_credentials'));
    await expect(flows.signInWithPassword('test@example.com', 'bad')).rejects.toMatchObject({
      code: 'invalid_credentials',
    });
  });
});

describe('no guest session in the middle of a sign-in', () => {
  it('refuses to start a guest while the Google page is open, and works again afterwards', async () => {
    let returnFromGoogle: (url: string | null) => void = () => undefined;
    deps.openAuthSession = vi.fn(
      () =>
        new Promise<string | null>((resolve) => {
          returnFromGoogle = resolve;
        }),
    );
    const flows = createAuthFlows(deps);
    const signIn = flows.signInWithGoogle();
    await vi.waitFor(() => {
      expect(deps.openAuthSession).toHaveBeenCalled();
    });
    // A save retried meanwhile must not make a guest that would replace the account.
    await expect(flows.ensureSession()).rejects.toMatchObject({ code: 'signing_in' });
    expect(fake.auth.signInAnonymously).not.toHaveBeenCalled();

    returnFromGoogle('outfitly://auth-callback?code=abc');
    expect(await signIn).toBe('signed_in');
    fake.setSession({ access_token: 'real-token', user: { is_anonymous: false } });
    hasProfile = true;
    await expect(flows.ensureSession()).resolves.toBeNull();
  });

  it('lets a save already on its way as the guest land before the guest content moves', async () => {
    fake.setSession(guest);
    const order: string[] = [];
    deps.beforeMerge = () => {
      order.push('saves settled');
      return Promise.resolve();
    };
    api.mergeGuest.mockImplementation(() => {
      order.push('merge');
      return Promise.resolve({});
    });
    await createAuthFlows(deps).signInWithPassword('test@example.com', 'pw');
    expect(order).toEqual(['saves settled', 'merge']);
  });

  it('moves a guest made while the email code was being typed', async () => {
    const flows = createAuthFlows(deps);
    expect(await flows.startEmail('new@example.com')).toBe('new');
    fake.setSession(guest); // the first save happened between the two steps
    fake.auth.verifyOtp.mockImplementationOnce(() => {
      fake.setSession({ access_token: 'real-token', user: { is_anonymous: false } });
      return ok();
    });
    expect(await flows.verifyEmail('new@example.com', '123456', 'new')).toBe('merged');
    expectMergedAfterSignIn();
  });
});
