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
  'conflict',
  'idempotency_key_required',
  'idempotency_key_reused',
  'idempotency_in_progress',
  'payload_too_large',
  'unsupported_media_type',
  'rate_limited',
  'internal_error',
  'service_unavailable',
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

export const healthSchema = z.object({ status: z.literal('ok') });

/** Which of the login's profiles a request acts as. The server checks the login may use it. */
export const ACTIVE_PROFILE_HEADER = 'x-profile-id';

export const profileSummarySchema = z.object({
  id: z.uuid(),
  handle: z.string(),
  displayName: z.string().nullable(),
  accountType: z.enum(['personal', 'creator', 'business']),
  role: z.enum(['owner', 'editor']),
});
export type ProfileSummary = z.infer<typeof profileSummarySchema>;

/** The login behind a request and its profiles (`GET /v1/me`, `POST /v1/session`). */
export const meSchema = z.object({
  userId: z.uuid(),
  isAnonymous: z.boolean(),
  activeProfileId: z.uuid().nullable(),
  profiles: z.array(profileSummarySchema),
});
export type Me = z.infer<typeof meSchema>;

/**
 * After signing in to an existing account from a guest session, the app hands
 * over the guest's token so the guest's saves and photos move to this account.
 */
export const mergeGuestBodySchema = z.object({ guestAccessToken: z.string().min(1) });
export const mergeGuestResultSchema = z.object({ merged: z.boolean() });
