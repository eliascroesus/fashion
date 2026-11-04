# apps/api

Fastify backend: REST under `/v1`, the only writer to the database, plus pg-boss background jobs.

- `pnpm dev:api` (root) runs it locally with `.env`; Node runs the TypeScript directly.
- Every route needs a Supabase login unless it sets `config: { public: true }`, and every route must declare a zod `response` schema (startup fails otherwise).
- Errors always look like `{ "error": { "code", "message", "requestId", "details?" } }` (`apiErrorSchema` in `@outfitly/shared`).
- Logged-in writes (POST/PUT/PATCH/DELETE) need an `Idempotency-Key` header; repeats replay the first response.
- Jobs: `src/jobs.ts` (`system-ping` test job, daily `idempotency-cleanup`, `media-process`, `event-partitions` at startup and daily, `search-terms` at startup and every 15 minutes).
- Photos (`src/media`, `src/routes/media.ts`): `POST /v1/media/uploads` → PUT the original to the signed R2 link → `POST /v1/media/:id/complete` → job makes 1080/600/300 WebP (EXIF/GPS stripped, HEIC via libheif WASM) plus thumbhash and dominant colour → `GET /v1/media/:id` shows the links. `pnpm media:try photo.heic` runs a real photo through R2 and prints the 3 links.
- Seed looks (dev only, never production; folder paths are relative to the repo root):
  - `pnpm seed:looks ./photos --init` writes `looks.json` with one look per photo; fill in `caption`, `tags` (any of the occasions/seasons in `@outfitly/shared`), `author` (handle; created as a creator profile if new, optional `authorName`). Put several file names in one `photos` list for a multi-photo look (first = cover).
  - `pnpm seed:looks ./photos` runs every photo through the real pipeline and creates published looks. The file is the source of truth: re-running updates instead of duplicating (a photo is known by its content, a look by its first photo), brings back seed looks that were hidden, and retires (soft-deletes) older looks of these photos that the file no longer has, e.g. after grouping photos or changing a cover. The first look in the file is the newest. Photos over 25 MB are refused before upload.
  - `pnpm seed:fake-looks [--count N]` adds speed-test looks (posters `@loadtest.01`–`20`, gradient placeholders) up to N (default 10,000); `--remove` deletes them all.
  - Both rebuild search's vocabulary when done.
- Search (`src/search.ts`, public): `GET /v1/search/looks?q=` (results, 20 per page), `/v1/search/suggest?q=` (while typing: searches and people), `/v1/search/popular` (tags for the chips). Looks carry a generated `search_vector` (tags + caption weigh A, AI description B; `'simple'` config, no stemming). Typos and Swedish tag words are matched against the `search_terms` vocabulary with pg_trgm (job `search-terms`, every 15 minutes and at startup). `pnpm search:speed` times it against staging.
- Profiles (`src/profile-page.ts`, public): `GET /v1/profiles/:id` (counts, following) and `/v1/profiles/:id/looks` (newest first).
- Deploy: `fly deploy . --config apps/api/fly.toml --dockerfile apps/api/Dockerfile` from the repo root. Migrations run as the release command.
