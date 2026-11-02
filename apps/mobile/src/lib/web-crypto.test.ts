import { createHash, webcrypto } from 'node:crypto';
import { createClient } from '@supabase/supabase-js';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { installWebCrypto, type WebCryptoSubset } from './web-crypto';

// expo-crypto is native; Node's crypto stands in for it.
vi.mock('expo-crypto', () => ({
  CryptoDigestAlgorithm: { SHA256: 'SHA-256' },
  digest: (_algorithm: string, data: Uint8Array) => {
    const bytes = createHash('sha256').update(data).digest();
    return Promise.resolve(bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.length));
  },
  getRandomValues: (array: Uint32Array) => webcrypto.getRandomValues(array),
}));

const cryptoOf = (target: object) =>
  (target as { crypto: WebCryptoSubset & { randomUUID?: () => string } }).crypto;
const sha256Hex = (text: string) => createHash('sha256').update(text).digest('hex');
const hex = (buffer: ArrayBuffer) => Buffer.from(buffer).toString('hex');
const bytes = (text: string) => new TextEncoder().encode(text);

describe('installWebCrypto (for Supabase PKCE on Hermes)', () => {
  it('adds SHA-256 and random values when there is no crypto at all', async () => {
    const target = {};
    installWebCrypto(target);
    const { subtle, getRandomValues } = cryptoOf(target);
    expect(hex(await subtle.digest('SHA-256', bytes('verifier')))).toBe(sha256Hex('verifier'));
    expect(hex(await subtle.digest({ name: 'SHA-256' }, bytes('v')))).toBe(sha256Hex('v'));
    expect(getRandomValues(new Uint32Array(8)).some((n) => n !== 0)).toBe(true);
    await expect(subtle.digest('SHA-1', bytes('v'))).rejects.toThrow('Unsupported');
  });

  it('adds digest to a frozen runtime crypto and keeps its own methods', async () => {
    const runtimeRandom = vi.fn((array: Uint32Array) => array);
    const target = {
      crypto: Object.freeze({ getRandomValues: runtimeRandom, randomUUID: () => 'id' }),
    };
    installWebCrypto(target);
    const crypto = cryptoOf(target);
    expect(crypto.randomUUID?.()).toBe('id');
    crypto.getRandomValues(new Uint32Array(4));
    expect(runtimeRandom).toHaveBeenCalledOnce();
    expect(hex(await crypto.subtle.digest('SHA-256', bytes('x')))).toBe(sha256Hex('x'));
  });

  it('leaves a complete WebCrypto alone', () => {
    const complete = { getRandomValues: vi.fn(), subtle: { digest: vi.fn() } };
    const target = { crypto: complete };
    installWebCrypto(target);
    expect(target.crypto).toBe(complete);
  });
});

/** Every string inside stored JSON values (the verifier's storage format is internal to auth-js). */
function storedStrings(values: Iterable<string>): string[] {
  const found: string[] = [];
  const walk = (value: unknown): void => {
    if (typeof value === 'string') found.push(value, ...value.split('/'));
    else if (value && typeof value === 'object') Object.values(value).forEach(walk);
  };
  for (const raw of values) {
    try {
      walk(JSON.parse(raw));
    } catch {
      walk(raw);
    }
  }
  return found;
}

describe('Supabase login with the shim and no runtime crypto (as on Hermes)', () => {
  afterEach(() => {
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
  });

  it('uses the S256 PKCE challenge, derived from the stored verifier', async () => {
    vi.stubGlobal('crypto', undefined);
    installWebCrypto(globalThis);
    const warn = vi.spyOn(console, 'warn');
    const stored = new Map<string, string>();
    const client = createClient('https://project.supabase.co', 'sb_publishable_test', {
      auth: {
        storage: {
          getItem: (key) => stored.get(key) ?? null,
          setItem: (key, value) => {
            stored.set(key, value);
          },
          removeItem: (key) => {
            stored.delete(key);
          },
        },
        persistSession: true,
        autoRefreshToken: false,
        detectSessionInUrl: false,
        flowType: 'pkce',
      },
    });

    const { data, error } = await client.auth.signInWithOAuth({
      provider: 'google',
      options: { skipBrowserRedirect: true, redirectTo: 'outfitly://auth-callback' },
    });

    expect(error).toBeNull();
    const url = new URL(data.url ?? '');
    expect(url.searchParams.get('code_challenge_method')).toBe('s256');
    const challenge = url.searchParams.get('code_challenge');
    const matches = storedStrings(stored.values()).filter(
      (s) => createHash('sha256').update(s).digest('base64url') === challenge,
    );
    expect(matches.length).toBeGreaterThan(0);
    expect(warn.mock.calls.flat().join(' ')).not.toContain('WebCrypto');
  });
});
