import { z } from 'zod';
import { lookAuthorSchema } from './look-page.ts';

/**
 * `GET /v1/profiles/:profileId`: the top of a profile screen. Counts leave
 * out deleted profiles and looks that can't be shown.
 */
export const profilePageSchema = lookAuthorSchema.extend({
  counts: z.object({
    looks: z.number().int().nonnegative(),
    followers: z.number().int().nonnegative(),
    following: z.number().int().nonnegative(),
  }),
});
export type ProfilePage = z.infer<typeof profilePageSchema>;
