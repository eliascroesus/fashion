import { createHash, webcrypto } from 'node:crypto';
import { describe, expect, it, vi } from 'vitest';
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
