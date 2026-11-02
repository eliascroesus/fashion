import type { FastifyInstance, FastifyRequest } from 'fastify';
import { createRemoteJWKSet, errors as joseErrors, jwtVerify, type JWTVerifyGetKey } from 'jose';
import { z } from 'zod';
import { ApiError } from './errors.ts';

/** Who sent the request: a Supabase login, possibly an anonymous (guest) one. */
export interface AuthContext {
  userId: string;
  isAnonymous: boolean;
  /** Present once the login has an email (never for guests). */
  email: string | undefined;
}

declare module 'fastify' {
  interface FastifyRequest {
    auth: AuthContext | null;
  }
  interface FastifyContextConfig {
    /** Routes are login-only unless they opt out with `config: { public: true }`. */
    public?: boolean;
  }
}

const claimsSchema = z.object({
  sub: z.uuid(),
  role: z.literal('authenticated'),
  is_anonymous: z.boolean().optional(),
  email: z.string().optional(),
});

/** Supabase's public signing keys for this project (cached by jose). */
export function supabaseJwks(supabaseUrl: string): JWTVerifyGetKey {
  return createRemoteJWKSet(new URL('/auth/v1/.well-known/jwks.json', supabaseUrl), {
    timeoutDuration: 5_000,
  });
}

export interface AuthOptions {
  supabaseUrl: string;
  jwks: JWTVerifyGetKey;
}

async function verify(request: FastifyRequest, options: AuthOptions): Promise<AuthContext | null> {
  const header = request.headers.authorization;
  if (!header) return null;
  const match = /^Bearer (\S+)$/i.exec(header);
  if (!match?.[1]) throw new ApiError(401, 'unauthorized', 'Malformed Authorization header.');
  return verifyAccessToken(match[1], options, request.log);
}

/** Checks one Supabase access token (also used for a guest's token when merging). */
export async function verifyAccessToken(
  token: string,
  options: AuthOptions,
  log: FastifyRequest['log'],
): Promise<AuthContext> {
  try {
    const { payload } = await jwtVerify(token, options.jwks, {
      issuer: new URL('/auth/v1', options.supabaseUrl).toString(),
      audience: 'authenticated',
      algorithms: ['ES256', 'RS256'],
    });
    const claims = claimsSchema.parse(payload);
    return {
      userId: claims.sub,
      isAnonymous: claims.is_anonymous ?? false,
      email: claims.email || undefined,
    };
  } catch (error) {
    // Couldn't fetch Supabase's keys: our problem, not a logged-out user.
    const keysUnavailable =
      error instanceof joseErrors.JWKSTimeout ||
      error instanceof joseErrors.JWKSInvalid ||
      !(error instanceof joseErrors.JOSEError || error instanceof z.ZodError);
    if (keysUnavailable) {
      log.error({ err: error }, 'could not load Supabase signing keys');
      throw new ApiError(503, 'service_unavailable', 'Login check is unavailable. Try again.');
    }
    throw new ApiError(401, 'unauthorized', 'Invalid or expired login.');
  }
}

/** The login behind a non-public route (the auth hook has already enforced it). */
export function requireAuth(request: FastifyRequest): AuthContext {
  if (!request.auth) throw new ApiError(401, 'unauthorized', 'Log in to do this.');
  return request.auth;
}

/**
 * Checks Supabase login tokens (including anonymous ones) and sets
 * `request.auth`. Every route needs a login unless marked public.
 */
export function registerAuth(app: FastifyInstance, options: AuthOptions): void {
  app.decorateRequest('auth', null);
  // preParsing: after rate limiting (a per-route onRequest hook), before the body is read.
  app.addHook('preParsing', async (request, _reply, payload) => {
    request.auth = await verify(request, options);
    if (!request.auth && !request.routeOptions.config.public && !request.is404) {
      throw new ApiError(401, 'unauthorized', 'Log in to do this.');
    }
    return payload;
  });
}
