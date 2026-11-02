# apps/api

Fastify backend: REST under `/v1`, the only writer to the database, plus pg-boss background jobs.

- `pnpm dev:api` (root) runs it locally with `.env`; Node runs the TypeScript directly.
- Every route needs a Supabase login unless it sets `config: { public: true }`, and every route must declare a zod `response` schema (startup fails otherwise).
- Errors always look like `{ "error": { "code", "message", "requestId", "details?" } }` (`apiErrorSchema` in `@outfitly/shared`).
- Logged-in writes (POST/PUT/PATCH/DELETE) need an `Idempotency-Key` header; repeats replay the first response.
- Jobs: `src/jobs.ts` (`system-ping` test job, daily `idempotency-cleanup`).
- Deploy: `fly deploy . --config apps/api/fly.toml --dockerfile apps/api/Dockerfile` from the repo root. Migrations run as the release command.
