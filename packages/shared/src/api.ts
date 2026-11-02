import { z } from 'zod';

/** Every REST route lives under this prefix. */
export const API_PREFIX = '/v1';

/** Header every client write must carry so retries never create duplicates. */
export const IDEMPOTENCY_KEY_HEADER = 'idempotency-key';
export const IDEMPOTENCY_KEY_PATTERN = /^[A-Za-z0-9_-]{8,255}$/;

/** Set on a response that replays the stored result of an earlier identical write. */
export const IDEMPOTENT_REPLAY_HEADER = 'idempotent-replayed';

export const API_ERROR_CODES = [
  'validation_failed',
  'unauthorized',
  'forbidden',
  'not_found',
  'idempotency_key_required',
  'idempotency_key_reused',
  'idempotency_in_progress',
  'rate_limited',
  'internal_error',
] as const;
export type ApiErrorCode = (typeof API_ERROR_CODES)[number];

/** The one error format every API failure uses. */
export const apiErrorSchema = z.object({
  error: z.object({
    code: z.enum(API_ERROR_CODES),
    message: z.string(),
    requestId: z.string(),
    details: z.unknown().optional(),
  }),
});
export type ApiErrorBody = z.infer<typeof apiErrorSchema>;
