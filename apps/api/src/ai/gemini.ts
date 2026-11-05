/**
 * Gemini over plain `fetch` (no SDK): one `generateContent` call that answers
 * in JSON. Paid tier only: Google's terms don't allow the free tier for apps
 * used by people in the EEA.
 */

/**
 * US dollars per million tokens on the standard paid tier
 * (https://ai.google.dev/gemini-api/docs/pricing, checked 2026-11-05). Photos
 * count as input tokens; thinking is billed as output. Only models listed here
 * can be configured, so every call has a known cost for the daily cap.
 */
export const GEMINI_PRICES = {
  'gemini-3.1-flash-lite': { input: 0.25, output: 1.5 },
  'gemini-3.5-flash-lite': { input: 0.3, output: 2.5 },
  'gemini-2.5-flash-lite': { input: 0.1, output: 0.4 },
} as const;
export type GeminiModel = keyof typeof GEMINI_PRICES;

export const GEMINI_ENDPOINT = 'https://generativelanguage.googleapis.com/v1beta/models';

export interface GeminiUsage {
  inputTokens: number;
  outputTokens: number;
  thinkingTokens: number;
}

/** Cost in millionths of a dollar (a price per million tokens is micro-dollars per token). */
export function costMicros(model: GeminiModel, usage: GeminiUsage): number {
  const price = GEMINI_PRICES[model];
  return Math.ceil(
    usage.inputTokens * price.input + (usage.outputTokens + usage.thinkingTokens) * price.output,
  );
}

/** No answer: network trouble, a timeout or an error status. `retryable` = worth trying later. */
export class GeminiError extends Error {
  readonly httpStatus: number | null;
  readonly retryable: boolean;

  constructor(message: string, httpStatus: number | null, retryable: boolean) {
    super(message);
    this.name = 'GeminiError';
    this.httpStatus = httpStatus;
    this.retryable = retryable;
  }
}

export interface GeminiRequest {
  prompt: string;
  image: { mimeType: string; data: Buffer };
  /** JSON Schema of the answer (`responseJsonSchema`). */
  schema: object;
  maxOutputTokens: number;
}

export interface GeminiAnswer {
  /** The answer's text (JSON), or null when Gemini refused. */
  text: string | null;
  /** Why Gemini refused (prompt block reason or a safety finish reason), else null. */
  refusal: string | null;
  finishReason: string | null;
  usage: GeminiUsage;
  modelVersion: string | null;
}

export type ThinkingLevel = 'MINIMAL' | 'LOW' | 'MEDIUM' | 'HIGH' | 'MODEL_DEFAULT';

export interface GeminiOptions {
  apiKey: string;
  model: GeminiModel;
  thinkingLevel: ThinkingLevel;
  mediaResolution?: 'LOW' | 'MEDIUM' | 'HIGH' | undefined;
  /** Tests pass a fake. */
  fetch?: typeof fetch;
  timeoutMs?: number;
}

/** Finish reasons that mean "refused for safety", not "broken". */
const REFUSALS = new Set([
  'SAFETY',
  'PROHIBITED_CONTENT',
  'BLOCKLIST',
  'SPII',
  'IMAGE_SAFETY',
  'IMAGE_PROHIBITED_CONTENT',
]);

interface RawResponse {
  candidates?: {
    content?: { parts?: { text?: string; thought?: boolean }[] };
    finishReason?: string;
  }[];
  promptFeedback?: { blockReason?: string };
  usageMetadata?: {
    promptTokenCount?: number;
    candidatesTokenCount?: number;
    thoughtsTokenCount?: number;
  };
  modelVersion?: string;
}

export class GeminiClient {
  readonly model: GeminiModel;
  readonly #options: GeminiOptions;
  readonly #fetch: typeof fetch;

  constructor(options: GeminiOptions) {
    this.model = options.model;
    this.#options = options;
    this.#fetch = options.fetch ?? fetch;
  }

  async generateJson(request: GeminiRequest): Promise<GeminiAnswer> {
    const { thinkingLevel, mediaResolution } = this.#options;
    const body = {
      contents: [
        {
          role: 'user',
          parts: [
            // Photo first, then the instructions (Google's advice for one image).
            {
              inlineData: {
                mimeType: request.image.mimeType,
                data: request.image.data.toString('base64'),
              },
            },
            { text: request.prompt },
          ],
        },
      ],
      generationConfig: {
        responseMimeType: 'application/json',
        responseJsonSchema: request.schema,
        maxOutputTokens: request.maxOutputTokens,
        ...(thinkingLevel === 'MODEL_DEFAULT' ? {} : { thinkingConfig: { thinkingLevel } }),
        ...(mediaResolution ? { mediaResolution: `MEDIA_RESOLUTION_${mediaResolution}` } : {}),
      },
    };

    let response: Response;
    try {
      response = await this.#fetch(`${GEMINI_ENDPOINT}/${this.model}:generateContent`, {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          'x-goog-api-key': this.#options.apiKey,
        },
        body: JSON.stringify(body),
        signal: AbortSignal.timeout(this.#options.timeoutMs ?? 60_000),
      });
    } catch (error) {
      const reason = error instanceof Error ? error.name : 'unknown';
      throw new GeminiError(`Gemini unreachable (${reason}).`, null, true);
    }

    if (!response.ok) {
      const detail = (await response.text().catch(() => '')).slice(0, 300);
      // Too many requests and Google-side trouble pass; a bad request or key won't.
      const retryable = response.status === 429 || response.status >= 500;
      throw new GeminiError(
        `Gemini answered ${String(response.status)}: ${detail}`,
        response.status,
        retryable,
      );
    }

    const raw = (await response.json()) as RawResponse;
    const usage: GeminiUsage = {
      inputTokens: raw.usageMetadata?.promptTokenCount ?? 0,
      outputTokens: raw.usageMetadata?.candidatesTokenCount ?? 0,
      thinkingTokens: raw.usageMetadata?.thoughtsTokenCount ?? 0,
    };
    const candidate = raw.candidates?.[0];
    const finishReason = candidate?.finishReason ?? null;
    const blockReason = raw.promptFeedback?.blockReason ?? null;
    const refusal =
      blockReason ?? (finishReason && REFUSALS.has(finishReason) ? finishReason : null);
    const text =
      refusal === null
        ? (candidate?.content?.parts ?? [])
            .filter((part) => part.thought !== true && typeof part.text === 'string')
            .map((part) => part.text)
            .join('')
        : null;
    return { text, refusal, finishReason, usage, modelVersion: raw.modelVersion ?? null };
  }
}
