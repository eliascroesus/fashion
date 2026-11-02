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
    refreshSession: vi.fn(() => ok()),
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
    updateUser: vi.fn((): Promise<unknown> => ok()),
    verifyOtp: vi.fn(() => ok()),
    signOut: vi.fn(() => {
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

let fake: ReturnType<typeof fakeAuth>;
let deps: FlowDeps & {
  api: { start: ReturnType<typeof vi.fn>; mergeGuest: ReturnType<typeof vi.fn> };
};

beforeEach(() => {
  fake = fakeAuth();
  deps = {
    auth: fake.auth as unknown as AuthClient,
    api: { start: vi.fn(() => Promise.resolve(ME)), mergeGuest: vi.fn(() => Promise.resolve({})) },
    getCaptchaToken: () => Promise.resolve('captcha-ok'),
    openAuthSession: vi.fn(() => Promise.resolve('outfitly://auth-callback?code=abc')),
    redirectTo: 'outfitly://auth-callback',
    onSignedIn: vi.fn(),
    onSignedOut: vi.fn(),
  };
});

const guest = { access_token: 'guest-token', user: { is_anonymous: true } };

describe('ensureSession (first save)', () => {
  it('creates a guest session with a CAPTCHA token and a profile', async () => {
    const flows = createAuthFlows(deps);
    await flows.ensureSession();
    expect(fake.auth.signInAnonymously).toHaveBeenCalledWith({
      options: { captchaToken: 'captcha-ok' },
    });
    expect(deps.api.start).toHaveBeenCalledOnce();
    expect(deps.onSignedIn).toHaveBeenCalledWith(ME);
  });

  it('does nothing when there is already a session', async () => {
    fake.setSession(guest);
    await createAuthFlows(deps).ensureSession();
    expect(fake.auth.signInAnonymously).not.toHaveBeenCalled();
  });
});

describe('Sign in with Apple', () => {
  it('upgrades a guest in place (same account, so the data stays)', async () => {
    fake.setSession(guest);
    const result = await createAuthFlows(deps).signInWithIdToken(
      'apple',
      'apple-id-token',
      'nonce',
    );
    expect(result).toBe('upgraded');
    expect(fake.auth.linkIdentity).toHaveBeenCalledWith({
      provider: 'apple',
      token: 'apple-id-token',
      nonce: 'nonce',
    });
    expect(fake.auth.signInWithIdToken).not.toHaveBeenCalled();
    expect(deps.api.mergeGuest).not.toHaveBeenCalled();
  });

  it('signs in to the existing account and moves the guest data when the Apple ID is taken', async () => {
    fake.setSession(guest);
    fake.auth.linkIdentity.mockImplementationOnce(() => err('identity_already_exists'));
    const result = await createAuthFlows(deps).signInWithIdToken('apple', 'apple-id-token');
    expect(result).toBe('merged');
    expect(fake.auth.signInWithIdToken).toHaveBeenCalled();
    expect(deps.api.mergeGuest).toHaveBeenCalledWith('guest-token');
  });

  it('surfaces other linking errors', async () => {
    fake.setSession(guest);
    fake.auth.linkIdentity.mockImplementationOnce(() => err('manual_linking_disabled'));
    await expect(createAuthFlows(deps).signInWithIdToken('apple', 't')).rejects.toMatchObject({
      code: 'manual_linking_disabled',
    });
  });

  it('just signs in when there is no guest', async () => {
    const result = await createAuthFlows(deps).signInWithIdToken('apple', 't');
    expect(result).toBe('signed_in');
    expect(fake.auth.linkIdentity).not.toHaveBeenCalled();
  });
});

describe('Google', () => {
  it('links Google to a guest through the browser', async () => {
    fake.setSession(guest);
    fake.auth.linkIdentity.mockImplementationOnce(() => ok({ url: 'https://supabase.test/link' }));
    const result = await createAuthFlows(deps).signInWithGoogle();
    expect(result).toBe('upgraded');
    expect(fake.auth.exchangeCodeForSession).toHaveBeenCalledWith('abc');
  });

  it('falls back to signing in and merging when that Google account exists', async () => {
    fake.setSession(guest);
    fake.auth.linkIdentity.mockImplementationOnce(() => ok({ url: 'https://supabase.test/link' }));
    vi.mocked(deps.openAuthSession)
      .mockResolvedValueOnce('outfitly://auth-callback#error=x&error_code=identity_already_exists')
      .mockResolvedValueOnce('outfitly://auth-callback?code=def');
    const result = await createAuthFlows(deps).signInWithGoogle();
    expect(result).toBe('merged');
    expect(fake.auth.exchangeCodeForSession).toHaveBeenCalledWith('def');
    expect(deps.api.mergeGuest).toHaveBeenCalledWith('guest-token');
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
    expect(deps.api.mergeGuest).toHaveBeenCalledWith('guest-token');
  });

  it('signs in (or up) without a guest', async () => {
    const flows = createAuthFlows(deps);
    expect(await flows.startEmail('new@example.com')).toBe('new');
    expect(await flows.verifyEmail('new@example.com', '654321', 'new')).toBe('signed_in');
    expect(deps.api.mergeGuest).not.toHaveBeenCalled();
  });
});

describe('sign out', () => {
  it('ends the session and clears local state', async () => {
    fake.setSession({ access_token: 'real', user: { is_anonymous: false } });
    await createAuthFlows(deps).signOut();
    expect(fake.auth.signOut).toHaveBeenCalled();
    expect(deps.onSignedOut).toHaveBeenCalled();
  });
});
