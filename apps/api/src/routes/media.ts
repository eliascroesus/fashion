import { and, type Db, eq, isNull, media } from '@outfitly/db';
import { createUploadBodySchema, mediaSchema, uploadTicketSchema } from '@outfitly/shared';
import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { ApiError } from '../errors.ts';
import { type JobQueue, QUEUES } from '../jobs.ts';
import { originalKey, toMediaResponse } from '../media/pipeline.ts';
import { requireActiveProfile } from '../profiles.ts';
import type { PhotoStorage } from '../storage.ts';
import type { ZodTypeProvider } from '../zod.ts';

export interface MediaRouteDeps {
  db: Db;
  storage: PhotoStorage;
  queue: JobQueue;
}

const idParams = z.object({ id: z.uuid() });

/**
 * Upload flow: (1) ask for an upload link, (2) PUT the original straight to
 * storage, (3) say it's done, (4) a background job makes the public sizes.
 */
export function mediaRoutes(app: FastifyInstance, { db, storage, queue }: MediaRouteDeps): void {
  const routes = app.withTypeProvider<ZodTypeProvider>();

  async function ownMedia(id: string, profileId: string) {
    const [row] = await db
      .select()
      .from(media)
      .where(and(eq(media.id, id), eq(media.ownerProfileId, profileId), isNull(media.deletedAt)));
    if (!row) throw new ApiError(404, 'not_found', 'Photo not found.');
    return row;
  }

  routes.post(
    '/media/uploads',
    { schema: { body: createUploadBodySchema, response: { 201: uploadTicketSchema } } },
    async (request, reply) => {
      const profileId = await requireActiveProfile(db, request);
      const id = crypto.randomUUID();
      const key = originalKey(id);
      await db.insert(media).values({
        id,
        ownerProfileId: profileId,
        originalKey: key,
        contentType: request.body.contentType,
        byteSize: request.body.byteSize,
      });
      const upload = await storage.presignOriginalUpload(key, request.body);
      return reply.status(201).send({
        mediaId: id,
        uploadUrl: upload.url,
        uploadHeaders: upload.headers,
        expiresAt: upload.expiresAt.toISOString(),
      });
    },
  );

  routes.post(
    '/media/:id/complete',
    { schema: { params: idParams, body: z.object({}), response: { 202: mediaSchema } } },
    async (request, reply) => {
      const profileId = await requireActiveProfile(db, request);
      const row = await ownMedia(request.params.id, profileId);
      if (row.status !== 'pending') return reply.status(202).send(toMediaResponse(row, storage));

      const size = await storage.originalSize(row.originalKey);
      if (size === null) {
        throw new ApiError(409, 'conflict', 'The photo has not been uploaded yet.');
      }
      if (size !== row.byteSize) {
        throw new ApiError(409, 'conflict', 'The uploaded photo does not match the upload link.');
      }

      const [updated] = await db
        .update(media)
        .set({ status: 'processing' })
        .where(and(eq(media.id, row.id), eq(media.status, 'pending')))
        .returning();
      if (updated) {
        await queue.send(QUEUES.mediaProcess, { mediaId: row.id }, { singletonKey: row.id });
      }
      return reply.status(202).send(toMediaResponse(updated ?? row, storage));
    },
  );

  routes.get(
    '/media/:id',
    { schema: { params: idParams, response: { 200: mediaSchema } } },
    async (request) => {
      const profileId = await requireActiveProfile(db, request);
      return toMediaResponse(await ownMedia(request.params.id, profileId), storage);
    },
  );
}
