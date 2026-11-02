# packages/db

Drizzle schema (`src/schema`), SQL migrations (`migrations/`), seed data and the database client.

- Change the schema, then `pnpm db:generate` to write a migration. Never edit applied migrations.
- `pnpm db:migrate` / `pnpm db:seed` use `DATABASE_URL` (+ `DATABASE_CA_CERT`) from the root `.env`.
- Every table: UUID `id`, `created_at`, `updated_at`; soft delete (`deleted_at`) for user-removable things; `.enableRLS()` with no policies.
- Tests (`test/`) run against a local Postgres 17 + pgvector shaped like Supabase (`test/supabase-shim.ts`) and prove clients can't read anything. `test/supabase-live.test.ts` checks the real project when `SUPABASE_URL` and `SUPABASE_PUBLISHABLE_KEY` are set.
