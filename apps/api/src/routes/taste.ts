import { tastePickerSchema, tasteSchema } from '@outfitly/shared';
import type { FastifyInstance } from 'fastify';
import type { FeedDeps } from '../feed/cards.ts';
import { requireActiveProfile } from '../profiles.ts';
import { pickerLooks, saveTaste } from '../taste.ts';
import type { ZodTypeProvider } from '../zod.ts';

/** The taste picker: its looks (public, shown at first open) and storing the answers. */
export function tasteRoutes(app: FastifyInstance, deps: FeedDeps): void {
  const routes = app.withTypeProvider<ZodTypeProvider>();

  routes.get(
    '/taste/picker',
    { config: { public: true }, schema: { response: { 200: tastePickerSchema } } },
    async () => pickerLooks(deps),
  );

  // Sent from the phone's outbox once there is a profile (the picker runs before any login).
  routes.put(
    '/taste',
    { schema: { body: tasteSchema, response: { 200: tasteSchema } } },
    async (request) => {
      const profileId = await requireActiveProfile(deps.db, request);
      return saveTaste(deps.db, profileId, request.body);
    },
  );
}
