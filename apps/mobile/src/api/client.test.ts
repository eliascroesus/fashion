import { describe, expect, it, vi } from 'vitest';
import { ApiRequestError, createApiClient } from './client';

const MEDIA_ID = '0b7c9f0e-3a51-4c56-9d2e-6f1a2b3c4d5e';

function jsonResponse(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json' },
  });
}

function setup(respond: (url: string, init: RequestInit) => Response | Promise<Response>) {
  const calls: { url: string; init: RequestInit }[] = [];
  const fetchMock = vi.fn((url: string, init: RequestInit) => {
    calls.push({ url, init });
    return Promise.resolve(respond(url, init));
  });
  let n = 0;
  const api = createApiClient({
    baseUrl: 'https://api.test',
    getAccessToken: () => Promise.resolve('token-123'),
    newIdempotencyKey: () => `key-${String(++n)}-abcdefgh`,
    fetch: fetchMock as unknown as typeof fetch,
    timeoutMs: 50,
  });
  return { api, calls };
}

const headersOf = (init: RequestInit) => init.headers as Record<string, string>;

describe('API client', () => {
  it('calls /v1 with the login token and checks the answer', async () => {
    const { api, calls } = setup(() => jsonResponse(200, { status: 'ok' }));
    expect(await api.health()).toEqual({ status: 'ok' });
    expect(calls[0]?.url).toBe('https://api.test/v1/health');
    expect(headersOf(calls[0]?.init ?? {})['authorization']).toBe('Bearer token-123');
  });

  it('adds a new idempotency key to every write, and reuses one passed in for a retry', async () => {
    const media = {
      id: MEDIA_ID,
      status: 'processing',
      width: null,
      height: null,
      thumbhash: null,
      dominantColor: null,
      urls: null,
    };
    const { api, calls } = setup(() => jsonResponse(202, media));
    await api.media.complete(MEDIA_ID);
    await api.media.complete(MEDIA_ID);
    await api.media.complete(MEDIA_ID, 'retry-key-123456');
    const keys = calls.map((c) => headersOf(c.init)['idempotency-key']);
    expect(keys).toEqual(['key-1-abcdefgh', 'key-2-abcdefgh', 'retry-key-123456']);
    expect(calls[0]?.init.body).toBe('{}');
  });

  it('does not send idempotency keys on reads', async () => {
    const { api, calls } = setup(() => jsonResponse(200, { userId: MEDIA_ID, isAnonymous: true }));
    await api.me();
    expect(headersOf(calls[0]?.init ?? {})['idempotency-key']).toBeUndefined();
  });

  it('turns the API error format into an ApiRequestError', async () => {
    const { api } = setup(() =>
      jsonResponse(401, { error: { code: 'unauthorized', message: 'Log in', requestId: 'r-1' } }),
    );
    await expect(api.me()).rejects.toMatchObject({
      name: 'ApiRequestError',
      status: 401,
      code: 'unauthorized',
      requestId: 'r-1',
    });
  });

  it('refuses answers that do not match the shared schema', async () => {
    const { api } = setup(() => jsonResponse(200, { status: 'maybe' }));
    await expect(api.health()).rejects.toMatchObject({ code: 'invalid_response' });
  });

  it('reports network failures and timeouts as network_error', async () => {
    const { api } = setup(
      (_url, init) =>
        new Promise<Response>((_resolve, reject) => {
          init.signal?.addEventListener('abort', () => {
            reject(new Error('aborted'));
          });
        }),
    );
    const error: unknown = await api.health().catch((e: unknown) => e);
    expect(error).toBeInstanceOf(ApiRequestError);
    expect(error).toMatchObject({ code: 'network_error', status: 0 });
  });
});
