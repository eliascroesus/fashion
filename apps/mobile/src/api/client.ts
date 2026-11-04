import {
  ACTIVE_PROFILE_HEADER,
  API_PREFIX,
  type ApiErrorCode,
  boardDeletedSchema,
  boardItemStateSchema,
  boardListSchema,
  boardSchema,
  type CreateUploadBody,
  type EventBatch,
  eventBatchResultSchema,
  feedPageSchema,
  followStateSchema,
  healthSchema,
  IDEMPOTENCY_KEY_HEADER,
  lookDetailSchema,
  mediaSchema,
  meSchema,
  mergeGuestResultSchema,
  popularTagsSchema,
  profilePageSchema,
  saveStateSchema,
  type Style,
  stylesParam,
  suggestionsSchema,
  swipeStateSchema,
  type Taste,
  tastePickerSchema,
  tasteSchema,
  uploadTicketSchema,
} from '@outfitly/shared';
import { z } from 'zod';

/**
 * Error answers are parsed leniently: an app in the field may meet error
 * codes from a newer server, and should still show the message.
 */
const errorBodySchema = z.object({
  error: z.object({
    code: z.string(),
    message: z.string(),
    requestId: z.string().optional(),
    details: z.unknown().optional(),
  }),
});

/**
 * An error answer from the API, or a network failure (`code: 'network_error'`).
 * `code` is one of the shared API error codes, or one this app version doesn't know yet.
 */
export class ApiRequestError extends Error {
  readonly status: number;
  readonly code: ApiErrorCode | 'network_error' | 'invalid_response' | (string & {});
  readonly requestId: string | undefined;
  readonly details: unknown;

  constructor(
    status: number,
    code: ApiRequestError['code'],
    message: string,
    requestId?: string,
    details?: unknown,
  ) {
    super(message);
    this.name = 'ApiRequestError';
    this.status = status;
    this.code = code;
    this.requestId = requestId;
    this.details = details;
  }
}

export interface ApiClientOptions {
  /** e.g. https://outfitly-api-staging.fly.dev (without /v1). */
  baseUrl: string;
  /** The Supabase access token, or null when not logged in. */
  getAccessToken: () => Promise<string | null>;
  /** The profile requests act as (sent as X-Profile-Id); the server checks it. */
  getActiveProfileId?: () => string | null;
  /** A fresh unique key per user action; a retry of the same action reuses it. */
  newIdempotencyKey: () => string;
  fetch?: typeof fetch;
  timeoutMs?: number;
}

interface RequestOptions<T extends z.ZodType> {
  schema: T;
  body?: unknown;
  /** Writes only: pass the action's key so retries can't duplicate it. */
  idempotencyKey?: string;
  /** Lets the caller cancel (e.g. TanStack Query dropping a page nobody needs). */
  signal?: AbortSignal;
}

/** Typed client for the Outfitly API: every response is checked against the shared schemas. */
export function createApiClient(options: ApiClientOptions) {
  const doFetch = options.fetch ?? fetch;
  const timeoutMs = options.timeoutMs ?? 15_000;

  async function request<T extends z.ZodType>(
    method: 'GET' | 'POST' | 'PUT' | 'PATCH' | 'DELETE',
    path: string,
    { schema, body, idempotencyKey, signal }: RequestOptions<T>,
  ): Promise<z.output<T>> {
    const headers: Record<string, string> = { accept: 'application/json' };
    const token = await options.getAccessToken();
    if (token) headers['authorization'] = `Bearer ${token}`;
    const profileId = options.getActiveProfileId?.();
    if (token && profileId) headers[ACTIVE_PROFILE_HEADER] = profileId;
    if (method !== 'GET') {
      headers[IDEMPOTENCY_KEY_HEADER] = idempotencyKey ?? options.newIdempotencyKey();
    }
    if (body !== undefined) headers['content-type'] = 'application/json';
    if (signal?.aborted) throw new ApiRequestError(0, 'network_error', 'Cancelled.');

    const controller = new AbortController();
    const timer = setTimeout(() => {
      controller.abort();
    }, timeoutMs);
    const cancel = () => {
      controller.abort();
    };
    signal?.addEventListener('abort', cancel);
    let res: Response;
    let json: unknown;
    try {
      res = await doFetch(`${options.baseUrl}${API_PREFIX}${path}`, {
        method,
        headers,
        ...(body === undefined ? {} : { body: JSON.stringify(body) }),
        signal: controller.signal,
      });
      // 204 has no body; the endpoint's schema must accept null. Non-JSON bodies become null.
      json = res.status === 204 ? null : await res.json().catch(() => null);
    } catch (error) {
      throw new ApiRequestError(0, 'network_error', String(error));
    } finally {
      clearTimeout(timer);
      signal?.removeEventListener('abort', cancel);
    }

    if (!res.ok) {
      const parsed = errorBodySchema.safeParse(json);
      if (parsed.success) {
        const { code, message, requestId, details } = parsed.data.error;
        throw new ApiRequestError(res.status, code, message, requestId, details);
      }
      throw new ApiRequestError(res.status, 'invalid_response', `HTTP ${String(res.status)}`);
    }
    const parsed = schema.safeParse(json);
    if (!parsed.success) {
      throw new ApiRequestError(res.status, 'invalid_response', parsed.error.message);
    }
    return parsed.data;
  }

  const page = (
    path: string,
    cursor?: string,
    signal?: AbortSignal,
    query: Record<string, string | undefined> = {},
  ) => {
    const params = Object.entries({ cursor, ...query }).flatMap(([name, value]) =>
      value ? [`${name}=${encodeURIComponent(value)}`] : [],
    );
    return request('GET', params.length > 0 ? `${path}?${params.join('&')}` : path, {
      schema: feedPageSchema,
      ...(signal ? { signal } : {}),
    });
  };

  const id = encodeURIComponent;

  return {
    health: () => request('GET', '/health', { schema: healthSchema }),
    me: () => request('GET', '/me', { schema: meSchema }),
    session: {
      start: () => request('POST', '/session', { schema: meSchema, body: {} }),
      mergeGuest: (guestAccessToken: string) =>
        request('POST', '/session/merge-guest', {
          schema: mergeGuestResultSchema,
          body: { guestAccessToken },
        }),
    },
    media: {
      createUpload: (body: CreateUploadBody, idempotencyKey?: string) =>
        request('POST', '/media/uploads', {
          schema: uploadTicketSchema,
          body,
          ...(idempotencyKey ? { idempotencyKey } : {}),
        }),
      complete: (mediaId: string, idempotencyKey?: string) =>
        request('POST', `/media/${encodeURIComponent(mediaId)}/complete`, {
          schema: mediaSchema,
          body: {},
          ...(idempotencyKey ? { idempotencyKey } : {}),
        }),
      get: (mediaId: string) =>
        request('GET', `/media/${encodeURIComponent(mediaId)}`, { schema: mediaSchema }),
    },
    feed: {
      /**
       * Works logged out. Leave out the cursor for a new list (page 1). `styles`:
       * the taste picked on this phone (the profile's stored taste wins over it).
       */
      forYou: (cursor?: string, signal?: AbortSignal, styles: readonly Style[] = []) =>
        page('/feed/for-you', cursor, signal, { styles: stylesParam(styles) }),
      following: (cursor?: string, signal?: AbortSignal) => page('/feed/following', cursor, signal),
    },
    looks: {
      /** Works logged out; logged in it also says saved / following for the active profile. */
      get: (lookId: string, signal?: AbortSignal) =>
        request('GET', `/looks/${id(lookId)}`, {
          schema: lookDetailSchema,
          ...(signal ? { signal } : {}),
        }),
      /** "More like this", 20 per page. */
      similar: (lookId: string, cursor?: string, signal?: AbortSignal) =>
        page(`/looks/${id(lookId)}/similar`, cursor, signal),
    },
    search: {
      /** Looks matching the words (typos too), 20 per page. Works logged out. */
      looks: (text: string, cursor?: string, signal?: AbortSignal) =>
        page('/search/looks', cursor, signal, { q: text }),
      /** While typing: whole searches and people. */
      suggest: (text: string, signal?: AbortSignal) =>
        request('GET', `/search/suggest?q=${encodeURIComponent(text)}`, {
          schema: suggestionsSchema,
          ...(signal ? { signal } : {}),
        }),
      /** The tags most looks carry, most first. */
      popular: (signal?: AbortSignal) =>
        request('GET', '/search/popular', {
          schema: popularTagsSchema,
          ...(signal ? { signal } : {}),
        }),
    },
    profiles: {
      /** The top of a profile screen (counts; whether the active profile follows it). */
      get: (profileId: string, signal?: AbortSignal) =>
        request('GET', `/profiles/${id(profileId)}`, {
          schema: profilePageSchema,
          ...(signal ? { signal } : {}),
        }),
      /** Their looks, newest first, 20 per page. */
      looks: (profileId: string, cursor?: string, signal?: AbortSignal) =>
        page(`/profiles/${id(profileId)}/looks`, cursor, signal),
    },
    taste: {
      /** The taste picker's looks (works logged out). */
      picker: (signal?: AbortSignal) =>
        request('GET', '/taste/picker', {
          schema: tastePickerSchema,
          ...(signal ? { signal } : {}),
        }),
      /** Stores the picked taste if the profile has none yet; answers with what it has. */
      save: (taste: Taste, idempotencyKey: string) =>
        request('PUT', '/taste', { schema: tasteSchema, body: taste, idempotencyKey }),
    },
    follows: {
      follow: (profileId: string, idempotencyKey: string) =>
        request('PUT', `/follows/${id(profileId)}`, {
          schema: followStateSchema,
          body: {},
          idempotencyKey,
        }),
      unfollow: (profileId: string, idempotencyKey: string) =>
        request('DELETE', `/follows/${id(profileId)}`, {
          schema: followStateSchema,
          idempotencyKey,
        }),
    },
    /** Writes take the user action's key: a retry of the same action must reuse it. */
    saves: {
      list: (cursor?: string, signal?: AbortSignal) => page('/saves', cursor, signal),
      save: (lookId: string, idempotencyKey: string) =>
        request('PUT', `/saves/${id(lookId)}`, {
          schema: saveStateSchema,
          body: {},
          idempotencyKey,
        }),
      unsave: (lookId: string, idempotencyKey: string) =>
        request('DELETE', `/saves/${id(lookId)}`, { schema: saveStateSchema, idempotencyKey }),
      /** "See less like this". */
      seeLess: (lookId: string, idempotencyKey: string) =>
        request('PUT', `/swipes/${id(lookId)}`, {
          schema: swipeStateSchema,
          body: { kind: 'see_less' },
          idempotencyKey,
        }),
    },
    boards: {
      /** With `lookId`, each board also says whether it holds that look. */
      list: (lookId?: string, signal?: AbortSignal) =>
        request('GET', lookId ? `/boards?lookId=${id(lookId)}` : '/boards', {
          schema: boardListSchema,
          ...(signal ? { signal } : {}),
        }),
      create: (name: string, idempotencyKey: string) =>
        request('POST', '/boards', { schema: boardSchema, body: { name }, idempotencyKey }),
      rename: (boardId: string, name: string, idempotencyKey: string) =>
        request('PATCH', `/boards/${id(boardId)}`, {
          schema: boardSchema,
          body: { name },
          idempotencyKey,
        }),
      remove: (boardId: string, idempotencyKey: string) =>
        request('DELETE', `/boards/${id(boardId)}`, { schema: boardDeletedSchema, idempotencyKey }),
      looks: (boardId: string, cursor?: string, signal?: AbortSignal) =>
        page(`/boards/${id(boardId)}/looks`, cursor, signal),
      addLook: (boardId: string, lookId: string, idempotencyKey: string) =>
        request('PUT', `/boards/${id(boardId)}/looks/${id(lookId)}`, {
          schema: boardItemStateSchema,
          body: {},
          idempotencyKey,
        }),
      removeLook: (boardId: string, lookId: string, idempotencyKey: string) =>
        request('DELETE', `/boards/${id(boardId)}/looks/${id(lookId)}`, {
          schema: boardItemStateSchema,
          idempotencyKey,
        }),
    },
    events: {
      /** Resending a batch is safe: the server skips event ids it already has. */
      send: (batch: EventBatch, idempotencyKey: string) =>
        request('POST', '/events', { schema: eventBatchResultSchema, body: batch, idempotencyKey }),
    },
  };
}

export type ApiClient = ReturnType<typeof createApiClient>;
