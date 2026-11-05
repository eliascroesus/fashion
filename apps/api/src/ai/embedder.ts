import { FINGERPRINT_DIMENSIONS } from '@outfitly/shared';
import { z } from 'zod';
import type { Box } from './spot.ts';

/** The fingerprint service takes at most this many boxes per photo (services/embedder). */
export const MAX_BOXES_PER_CALL = 20;

/** No fingerprints: `retryable` = worth trying later (network trouble, a waking machine). */
export class EmbedderError extends Error {
  readonly httpStatus: number | null;
  readonly retryable: boolean;

  constructor(message: string, httpStatus: number | null, retryable: boolean) {
    super(message);
    this.name = 'EmbedderError';
    this.httpStatus = httpStatus;
    this.retryable = retryable;
  }
}

const answerShape = z.object({
  model: z.string().min(1),
  embeddings: z.array(z.array(z.number()).length(FINGERPRINT_DIMENSIONS)),
});

export interface EmbedderOptions {
  url: string;
  secret: string;
  /** Tests pass a fake. */
  fetch?: typeof fetch;
  /**
   * 20 boxes take ~13 s; a machine starting after a deploy loads the model for
   * ~20 s first (Step 3.2 measurements).
   */
  timeoutMs?: number;
}

/** Client for services/embedder: a photo link (+ boxes) in, one fingerprint per box out. */
export class EmbedderClient {
  readonly #options: EmbedderOptions;
  readonly #fetch: typeof fetch;

  constructor(options: EmbedderOptions) {
    this.#options = options;
    this.#fetch = options.fetch ?? fetch;
  }

  async embedImage(
    imageUrl: string,
    boxes: readonly Box[],
  ): Promise<{ model: string; embeddings: number[][] }> {
    let response: Response;
    try {
      response = await this.#fetch(new URL('/embed-image', this.#options.url), {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          authorization: `Bearer ${this.#options.secret}`,
        },
        body: JSON.stringify({ url: imageUrl, boxes }),
        signal: AbortSignal.timeout(this.#options.timeoutMs ?? 45_000),
      });
    } catch (error) {
      const reason = error instanceof Error ? error.name : 'unknown';
      throw new EmbedderError(`Fingerprint service unreachable (${reason}).`, null, true);
    }
    if (!response.ok) {
      const detail = (await response.text().catch(() => '')).slice(0, 300);
      // 502/503: it couldn't fetch the photo or is starting; 4xx won't change by retrying.
      const retryable = response.status === 429 || response.status >= 500;
      throw new EmbedderError(
        `Fingerprint service answered ${String(response.status)}: ${detail}`,
        response.status,
        retryable,
      );
    }
    const answer = answerShape.safeParse(await response.json());
    if (!answer.success || answer.data.embeddings.length !== boxes.length) {
      throw new EmbedderError('Fingerprint service gave an unexpected answer.', 200, false);
    }
    return answer.data;
  }
}
