import { CryptoDigestAlgorithm, digest, getRandomValues } from 'expo-crypto';

export interface WebCryptoSubset {
  getRandomValues: typeof getRandomValues;
  subtle: {
    digest: (algorithm: string | { name: string }, data: BufferSource) => Promise<ArrayBuffer>;
  };
}

/** WebCrypto's digest, SHA-256 only (all that Supabase's PKCE needs). */
function sha256Digest(algorithm: string | { name: string }, data: BufferSource) {
  const name = typeof algorithm === 'string' ? algorithm : algorithm.name;
  if (name.toUpperCase() !== 'SHA-256') {
    return Promise.reject(new Error(`Unsupported digest algorithm: ${name}`));
  }
  return digest(CryptoDigestAlgorithm.SHA256, data);
}

/**
 * Hermes has no WebCrypto. Supabase login uses it for PKCE: without
 * `crypto.subtle` it falls back to the weaker "plain" code challenge, and
 * without `crypto` it makes the secret verifier with Math.random. This fills
 * in the two pieces it needs from expo-crypto and keeps anything that exists.
 */
export function installWebCrypto(target: object): void {
  const existing = (target as { crypto?: Partial<WebCryptoSubset> }).crypto;
  if (existing?.subtle && existing.getRandomValues) return;
  // A runtime-provided `crypto` may be frozen, so build a new object that
  // still inherits its other methods (e.g. randomUUID). Own properties are
  // defined, not assigned: assigning over a frozen parent's property throws.
  const crypto = Object.create(existing ?? null, {
    getRandomValues: {
      value: existing?.getRandomValues?.bind(existing) ?? getRandomValues,
      enumerable: true,
    },
    subtle: { value: existing?.subtle ?? { digest: sha256Digest }, enumerable: true },
  }) as WebCryptoSubset;
  Object.defineProperty(target, 'crypto', { value: crypto, configurable: true, writable: true });
}
