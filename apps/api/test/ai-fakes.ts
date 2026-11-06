import { FINGERPRINT_DIMENSIONS } from '@outfitly/shared';
import { EmbedderClient } from '../src/ai/embedder.ts';
import { GeminiClient } from '../src/ai/gemini.ts';

export interface FakeCall {
  url: string;
  headers: Record<string, string>;
  body: unknown;
}

/** A stand-in for `fetch` that records each call and answers with `handler`. */
export function fakeFetch(
  handler: (call: FakeCall, index: number) => Response | Promise<Response>,
) {
  const calls: FakeCall[] = [];
  const fetch = (async (input: string | URL | Request, init?: RequestInit) => {
    const call: FakeCall = {
      url: input instanceof Request ? input.url : input.toString(),
      headers: Object.fromEntries(new Headers(init?.headers).entries()),
      body: typeof init?.body === 'string' ? JSON.parse(init.body) : null,
    };
    calls.push(call);
    return handler(call, calls.length - 1);
  }) as typeof globalThis.fetch;
  return { fetch, calls };
}

export function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json' },
  });
}

/** A typical spotting answer: a coat and sneakers, nothing flagged. */
export const COAT_AND_SNEAKERS = {
  garments: [
    {
      category: 'coat',
      color: 'Beige',
      pattern: 'solid',
      material: 'wool',
      brand_text: '',
      box_2d: [100, 200, 600, 800],
    },
    {
      category: 'sneakers',
      color: 'white',
      pattern: 'solid',
      material: 'leather',
      brand_text: 'VEJA',
      box_2d: [850, 300, 980, 700],
    },
  ],
  description: 'A beige wool coat with white sneakers.',
  tags: ['Minimal', 'trench coat', 'beige', 'minimal'],
  safety: { nudity: false, violence: false, spam_text: false },
};

/** What Gemini's generateContent answers with `answer` as its JSON text. */
export function geminiResponse(
  answer: unknown,
  usage = { promptTokenCount: 1500, candidatesTokenCount: 300, thoughtsTokenCount: 20 },
): Response {
  return json({
    candidates: [
      {
        content: { parts: [{ text: JSON.stringify(answer) }], role: 'model' },
        finishReason: 'STOP',
      },
    ],
    usageMetadata: usage,
    modelVersion: 'gemini-3.1-flash-lite-001',
  });
}

export function fakeGemini(handler: Parameters<typeof fakeFetch>[0]) {
  const fake = fakeFetch(handler);
  const client = new GeminiClient({
    apiKey: 'test-gemini-key',
    model: 'gemini-3.1-flash-lite',
    thinkingLevel: 'MINIMAL',
    fetch: fake.fetch,
  });
  return { client, calls: fake.calls };
}

/** A fingerprint along one axis: box i of a call gets axis i. */
export function unitVector(axis: number): number[] {
  const v = new Array<number>(FINGERPRINT_DIMENSIONS).fill(0);
  v[axis % FINGERPRINT_DIMENSIONS] = 1;
  return v;
}

/** The fingerprint service, answering one fingerprint per box (or `handler`'s answer). */
export function fakeEmbedder(handler?: Parameters<typeof fakeFetch>[0]) {
  const fake = fakeFetch(
    handler ??
      ((call) => {
        const { boxes } = call.body as { boxes: unknown[] };
        return json({
          model: 'Marqo/marqo-fashionSigLIP@c56244c',
          embeddings: boxes.map((_, i) => unitVector(i)),
          timing: { downloadMs: 1, inferenceMs: 1 },
        });
      }),
  );
  const client = new EmbedderClient({
    url: 'https://embedder.test',
    secret: 'x'.repeat(32),
    fetch: fake.fetch,
  });
  return { client, calls: fake.calls };
}
