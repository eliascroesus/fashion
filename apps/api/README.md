# apps/api

Fastify backend: REST under `/v1`, the only writer to the database, plus pg-boss background jobs.

- `pnpm dev:api` (root) runs it locally with `.env`; Node runs the TypeScript directly.
- Every route needs a Supabase login unless it sets `config: { public: true }`, and every route must declare a zod `response` schema (startup fails otherwise).
- Errors always look like `{ "error": { "code", "message", "requestId", "details?" } }` (`apiErrorSchema` in `@outfitly/shared`).
- Logged-in writes (POST/PUT/PATCH/DELETE) need an `Idempotency-Key` header; repeats replay the first response.
- Jobs: `src/jobs.ts` (`system-ping` test job, daily `idempotency-cleanup`, `media-process`).
- Photos (`src/media`, `src/routes/media.ts`): `POST /v1/media/uploads` → PUT the original to the signed R2 link → `POST /v1/media/:id/complete` → job makes 1080/600/300 WebP (EXIF/GPS stripped, HEIC via libheif WASM) plus thumbhash and dominant colour → `GET /v1/media/:id` shows the links. `pnpm media:try photo.heic` runs a real photo through R2 and prints the 3 links.
- Deploy: `fly deploy . --config apps/api/fly.toml --dockerfile apps/api/Dockerfile` from the repo root. Migrations run as the release command.
