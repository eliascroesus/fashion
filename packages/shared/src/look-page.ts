import { z } from 'zod';
import { feedCardSchema } from './feed.ts';
import { MAX_LOOK_PHOTOS } from './looks.ts';

/** "More like this" under a look goes on for at most this many looks. */
export const MAX_SIMILAR_LOOKS = 200;

const photoSchema = feedCardSchema.shape.photo;

/** Who posted a look, as the viewer sees them. */
export const lookAuthorSchema = z.object({
  id: z.uuid(),
  handle: z.string(),
  displayName: z.string().nullable(),
  /** Their profile photo; null shows their first letter. */
  avatar: photoSchema.nullable(),
  isVerified: z.boolean(),
  /** Whether the viewer follows them (false when logged out). */
  isFollowing: z.boolean(),
});
export type LookAuthor = z.infer<typeof lookAuthorSchema>;

/** `GET /v1/looks/:lookId`: everything the look page shows (products arrive in Phase 3). */
export const lookDetailSchema = z.object({
  id: z.uuid(),
  slug: z.string(),
  caption: z.string().nullable(),
  publishedAt: z.iso.datetime(),
  /** In order; the first is the cover. Photos not ready yet are left out. */
  photos: z.array(photoSchema).min(1).max(MAX_LOOK_PHOTOS),
  author: lookAuthorSchema,
  /** Whether the viewer saved it (false when logged out). */
  saved: z.boolean(),
  itemCount: z.number().int().nonnegative(),
});
export type LookDetail = z.infer<typeof lookDetailSchema>;

/** `PUT` / `DELETE /v1/follows/:profileId`. */
export const followStateSchema = z.object({ profileId: z.uuid(), following: z.boolean() });
export type FollowState = z.infer<typeof followStateSchema>;
