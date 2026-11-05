import type { EmbedderClient } from './embedder.ts';

export interface WordFingerprint {
  model: string;
  embedding: number[];
}

export interface WordFingerprintOptions {
  /**
   * Search waits at most this long, then goes on with words alone. Fingerprinting
   * words takes ~230 ms on the service's CPU; a sleeping machine wakes in ~1 s.
   */
  timeoutMs?: number;
  /** Fingerprints of this many recent searches are kept in memory. */
  cacheSize?: number;
  /** Told about each failed try (e.g. to log it); search goes on regardless. */
  onError?: (error: unknown) => void;
}

/**
 * Fingerprints of searched words (services/embedder), so a search finds
 * looks that look like the words even without them in the caption. Recent
 * ones are kept in memory (searches repeat; the words' fingerprint never
 * changes for a model). Never throws: no answer in time is null, and search
 * carries on with words alone.
 */
export class WordFingerprints {
  readonly #embedder: EmbedderClient;
  readonly #timeoutMs: number;
  readonly #cacheSize: number;
  readonly #onError: (error: unknown) => void;
  /** Least recently used first (a Map keeps insertion order). */
  readonly #cache = new Map<string, WordFingerprint>();

  constructor(embedder: EmbedderClient, options: WordFingerprintOptions = {}) {
    this.#embedder = embedder;
    this.#timeoutMs = options.timeoutMs ?? 1500;
    this.#cacheSize = options.cacheSize ?? 500;
    this.#onError = options.onError ?? (() => undefined);
  }

  async get(words: string): Promise<WordFingerprint | null> {
    const cached = this.#cache.get(words);
    if (cached) {
      this.#cache.delete(words);
      this.#cache.set(words, cached);
      return cached;
    }
    try {
      const fingerprint = await this.#embedder.embedText(words, this.#timeoutMs);
      this.#cache.set(words, fingerprint);
      const oldest = this.#cache.keys().next();
      if (this.#cache.size > this.#cacheSize && !oldest.done) this.#cache.delete(oldest.value);
      return fingerprint;
    } catch (error) {
      this.#onError(error);
      return null;
    }
  }
}
