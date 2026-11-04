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
    const { api, calls } = setup(() =>
      jsonResponse(200, {
        userId: MEDIA_ID,
        isAnonymous: true,
        activeProfileId: null,
        profiles: [],
      }),
    );
    await api.me();
    expect(headersOf(calls[0]?.init ?? {})['idempotency-key']).toBeUndefined();
  });

  it('names the active profile on logged-in requests', async () => {
    const calls: RequestInit[] = [];
    const api = createApiClient({
      baseUrl: 'https://api.test',
      getAccessToken: () => Promise.resolve('token-123'),
      getActiveProfileId: () => MEDIA_ID,
      newIdempotencyKey: () => 'key-abcdefgh',
      fetch: ((_url: string, init: RequestInit) => {
        calls.push(init);
        return Promise.resolve(jsonResponse(200, { merged: true }));
      }) as unknown as typeof fetch,
    });
    await api.session.mergeGuest('guest-token');
    expect(headersOf(calls[0] ?? {})['x-profile-id']).toBe(MEDIA_ID);
    expect(calls[0]?.body).toBe('{"guestAccessToken":"guest-token"}');
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

  it('keeps the message of error codes this app version does not know yet', async () => {
    const { api } = setup(() =>
      jsonResponse(403, { error: { code: 'brand_new_code', message: 'Nope', requestId: 'r-2' } }),
    );
    await expect(api.me()).rejects.toMatchObject({
      status: 403,
      code: 'brand_new_code',
      message: 'Nope',
      requestId: 'r-2',
    });
  });

  it('reports a non-JSON error page (e.g. a proxy 502) with its status', async () => {
    const { api } = setup(() => new Response('<html>Bad gateway</html>', { status: 502 }));
    await expect(api.health()).rejects.toMatchObject({ status: 502, code: 'invalid_response' });
  });

  it('treats 204 as an empty (null) answer', async () => {
    const { api } = setup(() => new Response(null, { status: 204 }));
    // health expects a body, so an empty answer is invalid for it.
    await expect(api.health()).rejects.toMatchObject({ status: 204, code: 'invalid_response' });
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
  it('pages feeds with the cursor in the query string', async () => {
    const { api, calls } = setup(() => jsonResponse(200, { items: [], nextCursor: null }));
    await api.feed.forYou();
    await api.feed.following('a/b+c');
    expect(calls.map((c) => c.url)).toEqual([
      'https://api.test/v1/feed/for-you',
      'https://api.test/v1/feed/following?cursor=a%2Fb%2Bc',
    ]);
  });

  it("sends For You the phone's picked styles on every page", async () => {
    const { api, calls } = setup(() => jsonResponse(200, { items: [], nextCursor: null }));
    await api.feed.forYou(undefined, undefined, ['edgy', 'minimal']);
    await api.feed.forYou('c1', undefined, ['edgy']);
    await api.feed.forYou(undefined, undefined, []);
    expect(calls.map((c) => c.url)).toEqual([
      'https://api.test/v1/feed/for-you?styles=minimal%2Cedgy',
      'https://api.test/v1/feed/for-you?cursor=c1&styles=edgy',
      'https://api.test/v1/feed/for-you',
    ]);
  });

  it('sends event batches with the key it is given', async () => {
    const { api, calls } = setup(() => jsonResponse(200, { accepted: 1 }));
    const batch = {
      sessionId: MEDIA_ID,
      platform: 'ios' as const,
      events: [
        {
          id: MEDIA_ID,
          name: 'impression' as const,
          lookId: MEDIA_ID,
          position: 0,
          source: 'feed_for_you' as const,
          occurredAt: '2026-11-03T10:00:00.000Z',
        },
      ],
    };
    expect(await api.events.send(batch, 'batch-key-1234')).toEqual({ accepted: 1 });
    expect(headersOf(calls[0]?.init ?? {})['idempotency-key']).toBe('batch-key-1234');
    expect(JSON.parse(calls[0]?.init.body as string)).toEqual(batch);
  });

  it('stops a request the caller cancels', async () => {
    // A long timeout, so only the caller's cancel can end the request.
    const api = createApiClient({
      baseUrl: 'https://api.test',
      getAccessToken: () => Promise.resolve(null),
      newIdempotencyKey: () => 'key-abcdefgh',
      fetch: ((_url: string, init: RequestInit) =>
        new Promise<Response>((_resolve, reject) => {
          init.signal?.addEventListener('abort', () => {
            reject(new Error('aborted'));
          });
        })) as unknown as typeof fetch,
      timeoutMs: 60_000,
    });
    const before = new AbortController();
    before.abort();
    await expect(api.feed.forYou(undefined, before.signal)).rejects.toMatchObject({
      code: 'network_error',
    });

    const during = new AbortController();
    const pending = api.feed.forYou(undefined, during.signal);
    await new Promise((resolve) => setTimeout(resolve, 0));
    during.abort();
    await expect(pending).rejects.toMatchObject({ code: 'network_error' });
  });
});
