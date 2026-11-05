import { describe, expect, it } from 'vitest';
import { EmbedderError } from '../src/ai/embedder.ts';
import { costMicros, GeminiClient, GeminiError, thinkingConfig } from '../src/ai/gemini.ts';
import { boxFromGemini, MAX_GARMENTS, parseSpotAnswer, SPOT_SCHEMA } from '../src/ai/spot.ts';
import {
  COAT_AND_SNEAKERS,
  fakeEmbedder,
  fakeFetch,
  fakeGemini,
  geminiResponse,
  json,
} from './ai-fakes.ts';

describe("Gemini's boxes", () => {
  it('become fractions of the photo: [ymin, xmin, ymax, xmax] → left, top, right, bottom', () => {
    expect(boxFromGemini([100, 200, 600, 800])).toEqual({
      left: 0.2,
      top: 0.1,
      right: 0.8,
      bottom: 0.6,
    });
  });

  it('are clamped to the photo and have swapped corners put right', () => {
    expect(boxFromGemini([600, 800, 100, 1200])).toEqual({
      left: 0.8,
      top: 0.1,
      right: 1,
      bottom: 0.6,
    });
  });

  it('are dropped when empty, a speck or malformed', () => {
    expect(boxFromGemini([100, 100, 100, 500])).toBeNull();
    expect(boxFromGemini([100, 100, 105, 500])).toBeNull();
    expect(boxFromGemini([1, 2, 3])).toBeNull();
    expect(boxFromGemini([Number.NaN, 0, 500, 500])).toBeNull();
  });
});

describe('a spotting answer', () => {
  it('becomes garments, a sentence, clean search words and no flags', () => {
    const result = parseSpotAnswer(JSON.stringify(COAT_AND_SNEAKERS));
    expect(result).toEqual({
      garments: [
        {
          category: 'coat',
          color: 'beige',
          attributes: { pattern: 'solid', material: 'wool' },
          box: { left: 0.2, top: 0.1, right: 0.8, bottom: 0.6 },
        },
        {
          category: 'sneakers',
          color: 'white',
          attributes: { pattern: 'solid', material: 'leather', brandText: 'VEJA' },
          box: { left: 0.3, top: 0.85, right: 0.7, bottom: 0.98 },
        },
      ],
      description: 'A beige wool coat with white sneakers.',
      tags: ['minimal', 'trench coat', 'beige'],
      flags: [],
    });
  });

  it('drops pieces that do not fit, one by one, and caps the counts', () => {
    const piece = COAT_AND_SNEAKERS.garments[0];
    const answer = {
      ...COAT_AND_SNEAKERS,
      garments: [
        { ...piece, category: 'cape' },
        { ...piece, box_2d: [0, 0, 0, 0] },
        { ...piece, pattern: 'paisley', material: 'unknown', color: '' },
        'not a piece',
        ...Array.from({ length: 30 }, () => piece),
      ],
      tags: ['<b>bold</b>', 7, ...Array.from({ length: 20 }, (_, i) => `tag ${String(i)}`)],
      description: `${'very '.repeat(80)}long`,
    };
    const result = parseSpotAnswer(JSON.stringify(answer));
    expect(result?.garments).toHaveLength(MAX_GARMENTS);
    expect(result?.garments[0]).toMatchObject({ color: null, attributes: {} });
    expect(result?.tags[0]).toBe('b bold b');
    expect(result?.tags).toHaveLength(12);
    expect(result?.description?.length).toBeLessThanOrEqual(301);
    expect(result?.description?.endsWith('…')).toBe(true);
  });

  it('turns the safety answers into flags', () => {
    const result = parseSpotAnswer(
      JSON.stringify({
        ...COAT_AND_SNEAKERS,
        safety: { nudity: true, violence: false, spam_text: true },
      }),
    );
    expect(result?.flags).toEqual(['nudity', 'spam_text']);
  });

  it('is unusable when it is not the promised JSON', () => {
    expect(parseSpotAnswer('not json')).toBeNull();
    expect(parseSpotAnswer('{"garments": []}')).toBeNull();
    expect(parseSpotAnswer(JSON.stringify({ ...COAT_AND_SNEAKERS, safety: null }))).toBeNull();
  });

  it('asks for every garment category and box as Gemini documents it', () => {
    const items = SPOT_SCHEMA.properties.garments.items;
    expect(items.properties.category.enum).toContain('t_shirt');
    expect(items.properties.box_2d).toMatchObject({ minItems: 4, maxItems: 4 });
    expect(SPOT_SCHEMA.required).toEqual(['garments', 'description', 'tags', 'safety']);
  });

  it('leaves number bounds and list caps out of the format (Gemini refuses the request with them)', () => {
    const format = JSON.stringify(SPOT_SCHEMA);
    expect(format).not.toMatch(/"minimum"|"maximum"/);
    expect(SPOT_SCHEMA.properties.garments).not.toHaveProperty('maxItems');
    expect(SPOT_SCHEMA.properties.tags).not.toHaveProperty('maxItems');
  });
});

describe('the Gemini client', () => {
  const image = { mimeType: 'image/webp', data: Buffer.from('photo') };
  const request = {
    prompt: 'Find the pieces.',
    images: [image],
    schema: { type: 'object' },
    maxOutputTokens: 100,
  };

  it('sends the photo and the JSON schema, with the key in a header', async () => {
    const { client, calls } = fakeGemini(() => geminiResponse({ ok: true }));
    const answer = await client.generateJson(request);
    expect(calls[0]?.url).toBe(
      'https://generativelanguage.googleapis.com/v1beta/models/gemini-3.1-flash-lite:generateContent',
    );
    expect(calls[0]?.headers['x-goog-api-key']).toBe('test-gemini-key');
    expect(calls[0]?.url).not.toContain('test-gemini-key');
    expect(calls[0]?.body).toEqual({
      contents: [
        {
          role: 'user',
          parts: [
            {
              inlineData: { mimeType: 'image/webp', data: Buffer.from('photo').toString('base64') },
            },
            { text: 'Find the pieces.' },
          ],
        },
      ],
      generationConfig: {
        responseMimeType: 'application/json',
        responseJsonSchema: { type: 'object' },
        maxOutputTokens: 100,
        thinkingConfig: { thinkingLevel: 'MINIMAL' },
      },
    });
    expect(answer).toEqual({
      text: '{"ok":true}',
      refusal: null,
      finishReason: 'STOP',
      usage: { inputTokens: 1500, outputTokens: 300, thinkingTokens: 20 },
      modelVersion: 'gemini-3.1-flash-lite-001',
    });
  });

  it('sends several photos in order, each after its label', async () => {
    const { client, calls } = fakeGemini(() => geminiResponse({ ok: true }));
    await client.generateJson({
      ...request,
      images: [
        { ...image, label: 'Photo A:' },
        { mimeType: 'image/webp', data: Buffer.from('other'), label: 'Photo B:' },
      ],
    });
    const body = calls[0]?.body as { contents: { parts: unknown[] }[] };
    expect(body.contents[0]?.parts).toEqual([
      { text: 'Photo A:' },
      { inlineData: { mimeType: 'image/webp', data: Buffer.from('photo').toString('base64') } },
      { text: 'Photo B:' },
      { inlineData: { mimeType: 'image/webp', data: Buffer.from('other').toString('base64') } },
      { text: 'Find the pieces.' },
    ]);
  });

  it('leaves thinking to the model and sets the image detail when asked', async () => {
    const fake = fakeFetch(() => geminiResponse({}));
    const client = new GeminiClient({
      apiKey: 'k',
      model: 'gemini-3.5-flash-lite',
      thinkingLevel: 'MODEL_DEFAULT',
      mediaResolution: 'LOW',
      fetch: fake.fetch,
    });
    await client.generateJson(request);
    const config = (fake.calls[0]?.body as { generationConfig: Record<string, unknown> })
      .generationConfig;
    expect(config).not.toHaveProperty('thinkingConfig');
    expect(config['mediaResolution']).toBe('MEDIA_RESOLUTION_LOW');
  });

  it('gives Gemini 2.5 models a thinking budget instead of a level', async () => {
    const fake = fakeFetch(() => geminiResponse({}));
    const client = new GeminiClient({
      apiKey: 'k',
      model: 'gemini-2.5-flash-lite',
      thinkingLevel: 'MINIMAL',
      fetch: fake.fetch,
    });
    await client.generateJson(request);
    const config = (fake.calls[0]?.body as { generationConfig: Record<string, unknown> })
      .generationConfig;
    expect(config['thinkingConfig']).toEqual({ thinkingBudget: 0 });
    expect(thinkingConfig('gemini-2.5-flash-lite', 'HIGH')).toEqual({ thinkingBudget: 8192 });
    expect(thinkingConfig('gemini-3.5-flash-lite', 'LOW')).toEqual({ thinkingLevel: 'LOW' });
    expect(thinkingConfig('gemini-3.1-flash-lite', 'MODEL_DEFAULT')).toBeNull();
  });

  it('says a timed-out call may have been billed', async () => {
    const { client } = fakeGemini(() =>
      Promise.reject(new DOMException('The operation timed out.', 'TimeoutError')),
    );
    await expect(client.generateJson(request)).rejects.toMatchObject({
      retryable: true,
      maybeBilled: true,
    });
    const unreadable = fakeGemini(() => new Response('not json', { status: 200 }));
    await expect(unreadable.client.generateJson(request)).rejects.toMatchObject({
      httpStatus: 200,
      retryable: true,
      maybeBilled: true,
    });
  });

  it('skips thought parts', async () => {
    const { client } = fakeGemini(() =>
      json({
        candidates: [
          {
            content: { parts: [{ text: 'hmm', thought: true }, { text: '{"a":' }, { text: '1}' }] },
            finishReason: 'STOP',
          },
        ],
      }),
    );
    expect((await client.generateJson(request)).text).toBe('{"a":1}');
  });

  it('reports refusals instead of text', async () => {
    const blocked = fakeGemini(() =>
      json({
        promptFeedback: { blockReason: 'PROHIBITED_CONTENT' },
        usageMetadata: { promptTokenCount: 900 },
      }),
    );
    expect(await blocked.client.generateJson(request)).toMatchObject({
      text: null,
      refusal: 'PROHIBITED_CONTENT',
      usage: { inputTokens: 900, outputTokens: 0, thinkingTokens: 0 },
    });
    const safety = fakeGemini(() => json({ candidates: [{ finishReason: 'IMAGE_SAFETY' }] }));
    expect(await safety.client.generateJson(request)).toMatchObject({ refusal: 'IMAGE_SAFETY' });
  });

  it('says which failures are worth retrying', async () => {
    const busy = fakeGemini(() => json({ error: { message: 'quota' } }, 429));
    await expect(busy.client.generateJson(request)).rejects.toMatchObject({
      name: 'GeminiError',
      httpStatus: 429,
      retryable: true,
    });
    const down = fakeGemini(() => json({}, 503));
    await expect(down.client.generateJson(request)).rejects.toMatchObject({ retryable: true });
    const badKey = fakeGemini(() => json({ error: { message: 'API key not valid' } }, 400));
    await expect(badKey.client.generateJson(request)).rejects.toMatchObject({
      httpStatus: 400,
      retryable: false,
    });
    const offline = fakeGemini(() => Promise.reject(new TypeError('fetch failed')));
    const error = await offline.client.generateJson(request).catch((e: unknown) => e);
    expect(error).toBeInstanceOf(GeminiError);
    // Never reached Google: nothing billed.
    expect(error).toMatchObject({ httpStatus: null, retryable: true, maybeBilled: false });
  });

  it('prices a call from its tokens (thinking billed as output)', () => {
    // 3.1 Flash-Lite: $0.25 in, $1.50 out per million tokens.
    expect(
      costMicros('gemini-3.1-flash-lite', {
        inputTokens: 1000,
        outputTokens: 500,
        thinkingTokens: 100,
      }),
    ).toBe(250 + 900);
    expect(
      costMicros('gemini-2.5-flash-lite', { inputTokens: 1, outputTokens: 0, thinkingTokens: 0 }),
    ).toBe(1);
  });
});

describe('the fingerprint service client', () => {
  const box = { left: 0, top: 0, right: 1, bottom: 1 };

  it('sends the photo link and boxes with the secret', async () => {
    const { client, calls } = fakeEmbedder();
    const answer = await client.embedImage('https://img.test/m/1/1080.webp', [box, box]);
    expect(calls[0]?.url).toBe('https://embedder.test/embed-image');
    expect(calls[0]?.headers['authorization']).toBe(`Bearer ${'x'.repeat(32)}`);
    expect(calls[0]?.body).toEqual({ url: 'https://img.test/m/1/1080.webp', boxes: [box, box] });
    expect(answer.embeddings).toHaveLength(2);
    expect(answer.model).toBe('Marqo/marqo-fashionSigLIP@c56244c');
  });

  it('says which failures are worth retrying', async () => {
    const starting = fakeEmbedder(() => json({}, 503));
    await expect(starting.client.embedImage('u', [box])).rejects.toMatchObject({
      retryable: true,
      httpStatus: 503,
    });
    const refused = fakeEmbedder(() => json({}, 403));
    await expect(refused.client.embedImage('u', [box])).rejects.toMatchObject({
      retryable: false,
    });
    const short = fakeEmbedder(() => json({ model: 'm', embeddings: [] }));
    await expect(short.client.embedImage('u', [box])).rejects.toBeInstanceOf(EmbedderError);
  });
});
