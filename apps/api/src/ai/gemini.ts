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

/**
 * No answer: network trouble, a timeout or an error status. `retryable` = worth
 * trying later. `maybeBilled` = the request may have been answered (and billed)
 * after we stopped waiting, so the caller logs an estimated cost.
 */
export class GeminiError extends Error {
  readonly httpStatus: number | null;
  readonly retryable: boolean;
  readonly maybeBilled: boolean;

  constructor(message: string, httpStatus: number | null, retryable: boolean, maybeBilled = false) {
    super(message);
    this.name = 'GeminiError';
    this.httpStatus = httpStatus;
    this.retryable = retryable;
    this.maybeBilled = maybeBilled;
  }
}

/** Gemini 2.5 models take a thinking budget in tokens; 3.x take a level (and 400 on the other). */
const THINKING_BUDGETS = { MINIMAL: 0, LOW: 1024, MEDIUM: 4096, HIGH: 8192 } as const;

export function thinkingConfig(
  model: GeminiModel,
  level: ThinkingLevel,
): { thinkingLevel: string } | { thinkingBudget: number } | null {
  if (level === 'MODEL_DEFAULT') return null;
  return model.startsWith('gemini-2.5-')
    ? { thinkingBudget: THINKING_BUDGETS[level] }
    : { thinkingLevel: level };
}

export interface GeminiImage {
  mimeType: string;
  data: Buffer;
  /** Said just before the photo (e.g. "Photo A: …"), when there are several. */
  label?: string;
}

export interface GeminiRequest {
  prompt: string;
  /** One or more photos, sent in this order before the prompt. */
  images: GeminiImage[];
  /** JSON Schema of the answer (`responseJsonSchema`). */
  schema: object;
  maxOutputTokens: number;
  /** This request's own thinking level, instead of the client's (`GEMINI_THINKING_LEVEL`). */
  thinkingLevel?: ThinkingLevel;
  /** This request's own image detail; `MODEL_DEFAULT` sends none, whatever the client's is. */
  mediaResolution?: 'LOW' | 'MEDIUM' | 'HIGH' | 'MODEL_DEFAULT';
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
    const thinking = thinkingConfig(
      this.model,
      request.thinkingLevel ?? this.#options.thinkingLevel,
    );
    const resolution = request.mediaResolution ?? this.#options.mediaResolution;
    const mediaResolution = resolution === 'MODEL_DEFAULT' ? undefined : resolution;
    const body = {
      contents: [
        {
          role: 'user',
          // Photos first, then the instructions (Google's advice for images).
          parts: [
            ...request.images.flatMap((image) => [
              ...(image.label ? [{ text: image.label }] : []),
              { inlineData: { mimeType: image.mimeType, data: image.data.toString('base64') } },
            ]),
            { text: request.prompt },
          ],
        },
      ],
      generationConfig: {
        responseMimeType: 'application/json',
        responseJsonSchema: request.schema,
        maxOutputTokens: request.maxOutputTokens,
        ...(thinking ? { thinkingConfig: thinking } : {}),
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
      // A timeout means Google had the photo and may have answered (and billed) anyway.
      const timedOut = reason === 'TimeoutError' || reason === 'AbortError';
      throw new GeminiError(`Gemini unreachable (${reason}).`, null, true, timedOut);
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

    let raw: RawResponse;
    try {
      raw = (await response.json()) as RawResponse;
    } catch (error) {
      // Cut off or not JSON (a timeout while reading, a proxy page): answered, so maybe billed.
      const reason = error instanceof Error ? error.name : 'unknown';
      throw new GeminiError(`Gemini's answer could not be read (${reason}).`, 200, true, true);
    }
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
