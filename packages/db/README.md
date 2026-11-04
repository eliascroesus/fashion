# packages/db

Drizzle schema (`src/schema`), SQL migrations (`migrations/`), seed data and the database client.

- Change the schema, then `pnpm db:generate` to write a migration. Never edit applied migrations (also not on a branch once it's applied to `outfitly-dev`: the migrator only runs files newer than the last one it applied, so an edited one is silently skipped there).
- `pnpm db:migrate` / `pnpm db:seed` use `DATABASE_URL` (+ `DATABASE_CA_CERT`) from the root `.env`.
- Every table: UUID `id`, `created_at`, `updated_at`; soft delete (`deleted_at`) for user-removable things; `.enableRLS()` with no policies.
- Extension types and operator classes live in the `extensions` schema: after `pnpm db:generate`, write them as `extensions.halfvec(768)`, `extensions.halfvec_cosine_ops`, `extensions.gin_trgm_ops` in the migration so it never depends on the search path (0009–0011).
- `events` is partitioned by month (`PARTITION BY` is added by hand to the generated migration, which drizzle-kit can't express). `ensureEventPartitions` (run by the API at startup and daily) adds this month and the next two; `events_default` catches anything else.
- Tests (`test/`) run against a local Postgres 17 + pgvector shaped like Supabase (`test/supabase-shim.ts`) and prove clients can't read anything. `test/supabase-live.test.ts` checks the real project when `SUPABASE_URL` and `SUPABASE_PUBLISHABLE_KEY` are set.
