import { z } from 'zod';

/** Every photo is resized once, at upload, to these widths (WebP). Originals are never served. */
export const MEDIA_SIZES = [1080, 600, 300] as const;
export type MediaSize = (typeof MEDIA_SIZES)[number];

/** Formats the app may upload. iPhone photos arrive as HEIC. */
export const UPLOAD_CONTENT_TYPES = [
  'image/jpeg',
  'image/png',
  'image/webp',
  'image/heic',
  'image/heif',
] as const;

export const MAX_UPLOAD_BYTES = 25 * 1024 * 1024;

export const createUploadBodySchema = z.object({
  contentType: z.enum(UPLOAD_CONTENT_TYPES),
  byteSize: z.number().int().positive().max(MAX_UPLOAD_BYTES),
});
export type CreateUploadBody = z.infer<typeof createUploadBodySchema>;

/** Where and how the app uploads the original: a one-time PUT straight to storage. */
export const uploadTicketSchema = z.object({
  mediaId: z.uuid(),
  uploadUrl: z.url(),
  /** Send exactly these headers with the PUT. */
  uploadHeaders: z.record(z.string(), z.string()),
  expiresAt: z.iso.datetime(),
});
export type UploadTicket = z.infer<typeof uploadTicketSchema>;

export const mediaSchema = z.object({
  id: z.uuid(),
  status: z.enum(['pending', 'processing', 'ready', 'failed']),
  width: z.number().int().nullable(),
  height: z.number().int().nullable(),
  thumbhash: z.string().nullable(),
  dominantColor: z.string().nullable(),
  /** Public CDN links per width, once ready. */
  urls: z.object({ 1080: z.url(), 600: z.url(), 300: z.url() }).nullable(),
});
export type Media = z.infer<typeof mediaSchema>;
