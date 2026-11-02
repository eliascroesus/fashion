import type { Db } from '@outfitly/db';
import { meSchema, mergeGuestBodySchema, mergeGuestResultSchema } from '@outfitly/shared';
import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { type AuthOptions, requireAuth, verifyAccessToken } from '../auth.ts';
import { ApiError } from '../errors.ts';
import { ensurePersonalProfile, getMe, mergeGuestInto, requireActiveProfile } from '../profiles.ts';
import type { ZodTypeProvider } from '../zod.ts';

export interface SessionRouteDeps {
  db: Db;
  auth: AuthOptions;
}

export function sessionRoutes(app: FastifyInstance, { db, auth }: SessionRouteDeps): void {
  const routes = app.withTypeProvider<ZodTypeProvider>();

  /** The login and its profiles. */
  routes.get('/me', { schema: { response: { 200: meSchema } } }, async (request) =>
    getMe(db, requireAuth(request)),
  );

  /**
   * Called by the app after every sign-in (guest or real): makes sure the
   * login has its personal profile, then answers like GET /me.
   */
  routes.post(
    '/session',
    { schema: { body: z.object({}), response: { 200: meSchema } } },
    async (request) => {
      const login = requireAuth(request);
      await ensurePersonalProfile(db, login);
      return getMe(db, login);
    },
  );

  /**
   * The app was a guest, then signed in to an account that already existed:
   * move the guest's content into the profile this request acts as.
   */
  routes.post(
    '/session/merge-guest',
    { schema: { body: mergeGuestBodySchema, response: { 200: mergeGuestResultSchema } } },
    async (request) => {
      const login = requireAuth(request);
      if (login.isAnonymous) {
        throw new ApiError(403, 'forbidden', 'Sign in to an account before merging a guest.');
      }
      const guest = await verifyAccessToken(request.body.guestAccessToken, auth, request.log);
      if (!guest.isAnonymous) {
        throw new ApiError(403, 'forbidden', 'Only a guest session can be merged.');
      }
      if (guest.userId === login.userId) return { merged: false };
      const targetProfileId = await requireActiveProfile(db, request);
      return { merged: await mergeGuestInto(db, guest.userId, targetProfileId) };
    },
  );
}
