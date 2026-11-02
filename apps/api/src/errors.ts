import type { ApiErrorBody, ApiErrorCode } from '@outfitly/shared';
import type { FastifyError, FastifyInstance } from 'fastify';
import { z } from 'zod';

/** Throw this from any route or hook to answer with the one error format. */
export class ApiError extends Error {
  readonly statusCode: number;
  readonly code: ApiErrorCode;
  readonly details: unknown;

  constructor(statusCode: number, code: ApiErrorCode, message: string, details?: unknown) {
    super(message);
    this.name = 'ApiError';
    this.statusCode = statusCode;
    this.code = code;
    this.details = details;
  }
}

function toApiError(error: FastifyError | Error): ApiError {
  if (error instanceof ApiError) return error;
  // Fastify tags request validation failures with where they came from (body,
  // querystring...). A ZodError without that is a response breaking its own
  // schema: our bug, so it falls through to 500.
  if (error instanceof z.ZodError && 'validationContext' in error) {
    return new ApiError(
      400,
      'validation_failed',
      'The request is not valid.',
      error.issues.map((i) => ({ path: i.path.join('.'), message: i.message })),
    );
  }
  const status = 'statusCode' in error ? error.statusCode : undefined;
  if (status === 404) return new ApiError(404, 'not_found', 'Not found.');
  if (status && status >= 400 && status < 500) {
    // Fastify's own client errors (bad JSON, body too large, wrong content type).
    return new ApiError(400, 'validation_failed', error.message);
  }
  return new ApiError(500, 'internal_error', 'Something went wrong on our side.');
}

export function registerErrorHandlers(app: FastifyInstance): void {
  app.setErrorHandler((error: FastifyError, request, reply) => {
    const apiError = toApiError(error);
    if (apiError.statusCode >= 500) {
      request.log.error({ err: error }, 'request failed');
    }
    const body: ApiErrorBody = {
      error: {
        code: apiError.code,
        message: apiError.message,
        requestId: request.id,
        ...(apiError.details === undefined ? {} : { details: apiError.details }),
      },
    };
    return reply.status(apiError.statusCode).send(body);
  });

  app.setNotFoundHandler((request, reply) => {
    const body: ApiErrorBody = {
      error: { code: 'not_found', message: 'Not found.', requestId: request.id },
    };
    return reply.status(404).send(body);
  });
}
