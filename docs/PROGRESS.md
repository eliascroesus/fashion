# Outfitly — progress

Claude Code updates this file at the end of every session.

## Current step
Phase 1, Step 1.3 — Backend skeleton, live on a server

## Done
- Step 1.1 — Project skeleton and safety net (PR #1). Monorepo (pnpm + Turborepo), strict TypeScript, ESLint + Prettier, Vitest, GitHub Actions CI on every pull request. CI green.
- Step 1.2 — Database (PR #2) — **done locally; live Supabase part waiting on Elias.** Drizzle schema + migrations for `profiles`, `profile_members`, `media`, `feature_flags`; pgvector + pg_trgm; RLS on every table with no policies, and Supabase's API roles (anon / authenticated / service_role) have their access revoked for existing and future tables and functions. Seed script. Tests run on a real Postgres 17 + pgvector locally and in CI. Still to do once the Supabase project exists: see "Waiting on Elias".

## Decisions made
<!-- - YYYY-MM-DD — decision — why -->
- 2026-11-02 — Version 1 = Phases 1–5 (feed, look page, saves/boards, products with prices, creator upload, personal/creator/business accounts, Google pages + link-in-bio). Swipe mode, push, bulk import, share-out and Save to Outfitly moved to Phases 6–8.
- 2026-11-02 — TypeScript pinned to 6.0.x — typescript-eslint supports TS <6.1 only, and TS 7 (native) drops the JS compiler API that Expo/Next tooling uses.
- 2026-11-02 — `globals` pinned to ~17.13 — 17.14 was published a day earlier and pnpm 11 blocks brand-new releases (supply-chain guard).
- 2026-11-02 — Extensions live in the `extensions` schema (Supabase convention); later `vector`/`gin_trgm_ops` rely on Supabase's search_path (`"$user", public, extensions`), which the test shim copies.
- 2026-11-02 — `profile_members` rows are hard-deleted (a permission link, not user content); profiles and media are soft-deleted.
- 2026-11-02 — Scripts run with Node's built-in TypeScript support (Node ≥ 22.18), so no extra runner (tsx) is needed.
- 2026-11-02 — Database TLS uses Supabase's CA certificate (`DATABASE_CA_CERT`), not `sslmode` in the URL (pg 8 treats `require` as full verification and lets URL params override).
- 2026-11-02 — Elias asked Claude to work through Phase 1 and Phase 2 overnight without stopping. Each step still gets its own branch + PR, stacked on the previous step's branch; nothing is merged into `main` without Elias.

## Waiting on Elias
- **Supabase dev project (Step 1.2):** create project `outfitly-dev`, region **Stockholm (eu-north-1)**, and turn on "Enforce SSL". Then give Claude (or put in `.env`): the Session pooler connection string (port 5432), the SSL certificate (Database settings → SSL → Download), the Project URL and the publishable key. Claude then runs `pnpm db:migrate`, `pnpm db:seed` and the live test (`SUPABASE_URL` + key set), and checks `pg_default_acl` on the real project.

## Open decisions for Elias
- Domain name (outfitly.com or other)
- App ID (default `com.outfitly.app`)
- Dark or light theme by default (Step 5.3)
- English only or English + Swedish at launch (Step 5.3)
- 18+ only or teens allowed (Step 5.5)

## Known issues
- `main` has no branch protection yet, so a PR with a red check could still be merged (ask Elias to require the "Typecheck, lint, test" check).
- Step 1.2 migrations are proven on plain Postgres 17 with a Supabase-shaped shim, not yet on a real Supabase project (the hosted `postgres` role isn't a superuser). The live test will confirm.
- `pnpm audit`: moderate advisory in esbuild ≤0.24 via drizzle-kit (dev server only, not used) — dev-only, not exploitable here.
- `pnpm audit`: one moderate advisory in minimatch, pulled in only by ESLint (dev tool reading our own config) — not exploitable here; wait for upstream fix.

## Measured numbers
- Feed p95: —
- Look page open: —
- Cold start to cached feed: —
- AI cost per 1,000 photos: —
- Link-resolve success rate: —
- Monthly running cost estimate: —
- CI run time (typecheck + lint + test): ~20 s (Step 1.1)

## Later (parked ideas, not in current scope)
- Open the same look after a fresh install (deferred deep link)
- Relax `globals` back to `^17` once 17.14 is a few days old.
- Handles: release a soft-deleted profile's handle after a while; block `..` / leading/trailing dots; reserved-handle list (Step 4.x).
- Consider turning off Supabase's Data API (REST) entirely as a third lock (then adjust the live test).
- Run migrations once per deploy (Fly `release_command`) — Step 1.3.
- Pin GitHub Actions to commit SHAs (with Dependabot to keep them current); consider moving to `pnpm/setup` and pnpm 12.
