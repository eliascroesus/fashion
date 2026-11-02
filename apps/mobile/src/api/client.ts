import {
  API_PREFIX,
  apiErrorSchema,
  type ApiErrorCode,
  type CreateUploadBody,
  healthSchema,
  IDEMPOTENCY_KEY_HEADER,
  mediaSchema,
  meSchema,
  uploadTicketSchema,
} from '@outfitly/shared';
import type { z } from 'zod';

/** An error answer from the API, or a network failure (`code: 'network_error'`). */
export class ApiRequestError extends Error {
  readonly status: number;
  readonly code: ApiErrorCode | 'network_error' | 'invalid_response';
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
  /** The Supabase access token, or null when not logged in (Step 1.6). */
  getAccessToken: () => Promise<string | null>;
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
}

/** Typed client for the Outfitly API: every response is checked against the shared schemas. */
export function createApiClient(options: ApiClientOptions) {
  const doFetch = options.fetch ?? fetch;
  const timeoutMs = options.timeoutMs ?? 15_000;

  async function request<T extends z.ZodType>(
    method: 'GET' | 'POST' | 'PUT' | 'PATCH' | 'DELETE',
    path: string,
    { schema, body, idempotencyKey }: RequestOptions<T>,
  ): Promise<z.output<T>> {
    const headers: Record<string, string> = { accept: 'application/json' };
    const token = await options.getAccessToken();
    if (token) headers['authorization'] = `Bearer ${token}`;
    if (method !== 'GET') {
      headers[IDEMPOTENCY_KEY_HEADER] = idempotencyKey ?? options.newIdempotencyKey();
    }
    if (body !== undefined) headers['content-type'] = 'application/json';

    const controller = new AbortController();
    const timer = setTimeout(() => {
      controller.abort();
    }, timeoutMs);
    let res: Response;
    try {
      res = await doFetch(`${options.baseUrl}${API_PREFIX}${path}`, {
        method,
        headers,
        ...(body === undefined ? {} : { body: JSON.stringify(body) }),
        signal: controller.signal,
      });
    } catch (error) {
      throw new ApiRequestError(0, 'network_error', String(error));
    } finally {
      clearTimeout(timer);
    }

    const json: unknown = res.status === 204 ? null : await res.json().catch(() => null);
    if (!res.ok) {
      const parsed = apiErrorSchema.safeParse(json);
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

  return {
    health: () => request('GET', '/health', { schema: healthSchema }),
    me: () => request('GET', '/me', { schema: meSchema }),
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
  };
}

export type ApiClient = ReturnType<typeof createApiClient>;
