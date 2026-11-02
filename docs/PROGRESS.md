# Outfitly — progress

Claude Code updates this file at the end of every session.

## Current step
Phase 1, Step 1.6 — Login plumbing

## Done
- Step 1.1 — Project skeleton and safety net (PR #1). Monorepo (pnpm + Turborepo), strict TypeScript, ESLint + Prettier, Vitest, GitHub Actions CI on every pull request. CI green.
- Step 1.2 — Database (PR #2) — **done locally; live Supabase part waiting on Elias.** Drizzle schema + migrations for `profiles`, `profile_members`, `media`, `feature_flags`; pgvector + pg_trgm; RLS on every table with no policies, and Supabase's API roles (anon / authenticated / service_role) have their access revoked for existing and future tables and functions. Seed script. Tests run on a real Postgres 17 + pgvector locally and in CI. Still to do once the Supabase project exists: see "Waiting on Elias".
- Step 1.3 — Backend skeleton (PR #3) — **done locally and in CI; Fly staging deploy waiting on Elias.** Fastify API under `/v1`: `/v1/health`, `/v1/me` (login required), zod on every route (startup fails without response/body/params schemas), one error format, request ids + logs, Sentry (5xx only, no personal data), Supabase login check incl. guest tokens (503 if Supabase's keys can't be fetched), idempotency keys on every logged-in write (new `idempotency_keys` table), rate limiting per phone, pg-boss with a test job and a daily cleanup job. Dockerfile + `fly.toml` for `outfitly-api-staging` in Stockholm; CI builds the image, runs migrations in it, starts it and checks health / 401 / test job.
- Step 1.4 — Photo pipeline (PR #4) — **done locally and in CI; real Cloudflare R2 waiting on Elias.** Upload flow: ask for a link → upload the original straight to R2 → say done → a background job makes 1080/600/300 WebP (location/camera data removed, iPhone Display P3 colours converted to sRGB, HEIC supported) plus size, blurry preview (thumbhash) and main colour. Unsafe files (decompression bombs, SVG/GIF/TIFF, strips) are refused from the header; processing runs in a worker thread; failed jobs are marked failed after retries. `pnpm media:try photo.heic` prints the 3 links once R2 exists.
- Step 1.5 — App shell (PR #5) — **code done and bundles build in CI; running on phones waiting on Elias (Expo account + phones).** Expo SDK 58 app with five icon-only tabs (filled when active, named for screen readers), warm light + dark themes from `packages/ui-tokens` (contrast-tested), English + Swedish texts, typed API client, TanStack Query cached in MMKV, Sentry, translated error screen, EAS profiles (development / preview / production). Lint blocks hard-coded colours and untranslated text in the app.

## Decisions made
<!-- - YYYY-MM-DD — decision — why -->
- 2026-11-02 — Version 1 = Phases 1–5 (feed, look page, saves/boards, products with prices, creator upload, personal/creator/business accounts, Google pages + link-in-bio). Swipe mode, push, bulk import, share-out and Save to Outfitly moved to Phases 6–8.
- 2026-11-02 — TypeScript pinned to 6.0.x — typescript-eslint supports TS <6.1 only, and TS 7 (native) drops the JS compiler API that Expo/Next tooling uses.
- 2026-11-02 — `globals` pinned to ~17.13 — 17.14 was published a day earlier and pnpm 11 blocks brand-new releases (supply-chain guard).
- 2026-11-02 — Extensions live in the `extensions` schema (Supabase convention); later `vector`/`gin_trgm_ops` rely on Supabase's search_path (`"$user", public, extensions`), which the test shim copies.
- 2026-11-02 — `profile_members` rows are hard-deleted (a permission link, not user content); profiles and media are soft-deleted.
- 2026-11-02 — Scripts run with Node's built-in TypeScript support (Node ≥ 22.18), so no extra runner (tsx) is needed.
- 2026-11-02 — Database TLS uses Supabase's CA certificate (`DATABASE_CA_CERT`), not `sslmode` in the URL (pg 8 treats `require` as full verification and lets URL params override).
- 2026-11-02 — API: own small zod "type provider" instead of `fastify-type-provider-zod` (that one forces unused Swagger packages in).
- 2026-11-02 — drizzle-orm query helpers are re-exported from `@outfitly/db` so every package uses one copy (two copies broke types).
- 2026-11-02 — Idempotency keys are scoped per login (a dedupe record, not user content); 4xx answers are replayed like Stripe does; 5xx frees the key; write handlers must finish well under 60 s (slow work goes to jobs).
- 2026-11-02 — Login-only by default: a route must opt out with `config: { public: true }`. An invalid/expired token gets 401 even on public routes (the app refreshes and retries).
- 2026-11-02 — pg-boss v12, schema `pgboss`; API pool 5 + jobs pool 3 connections per machine.
- 2026-11-02 — Photos: sizes are widths (1080/600/300), never enlarged; WebP quality 80; keys `m/<media id>/<size>.webp` (never reused) with `Cache-Control: public, max-age=31536000, immutable`; originals stay private in a separate bucket. Limits: 25 MB upload, 50 MP (25 MP for HEIC), aspect ratio ≤ 4:1; formats JPEG/PNG/WebP/HEIC/AVIF only.
- 2026-11-02 — Media must belong to the active profile; `requireActiveProfile` looks it up server-side from `profile_members` (Step 1.6 adds automatic profile creation).
- 2026-11-02 — App rule for later (Steps 1.5/4.2): use a fresh Idempotency-Key per user action; a retry of the *same* action reuses its key (4xx answers like "not uploaded yet" are replayed for 24 h).
- 2026-11-02 — App: Expo SDK 58 (latest stable on 2026-11-02) with native tabs; iOS icons are SF Symbols, Android icons Ionicons (the Material font has no filled/outline difference). The theme follows the phone's light/dark setting until Step 5.3.
- 2026-11-02 — App id `com.outfitly.app`; development builds are `com.outfitly.app.dev` ("Outfitly (Dev)", scheme `outfitly-dev`) so both can be installed. Preview builds talk to the staging API.
- 2026-11-02 — The app's cache is wiped on each new app version (cache "buster"), and requests aren't retried on answers that won't change (4xx except 408/429).
- 2026-11-02 — Elias asked Claude to work through Phase 1 and Phase 2 overnight without stopping. Each step still gets its own branch + PR, stacked on the previous step's branch; nothing is merged into `main` without Elias.

## Waiting on Elias
- **Supabase dev project (Step 1.2):** create project `outfitly-dev`, region **Stockholm (eu-north-1)**, and turn on "Enforce SSL". Then give Claude (or put in `.env`): the Session pooler connection string (port 5432), the SSL certificate (Database settings → SSL → Download), the Project URL and the publishable key. Claude then runs `pnpm db:migrate`, `pnpm db:seed` and the live test (`SUPABASE_URL` + key set), and checks `pg_default_acl` on the real project.

- **Fly.io staging API (Step 1.3)** — needs the Supabase project above first. Install flyctl and log in (`brew install flyctl && fly auth login`), or give Claude a Fly deploy token. Then: `fly apps create outfitly-api-staging`, `fly secrets set DATABASE_URL=… DATABASE_CA_CERT=… SUPABASE_URL=… SENTRY_DSN=… -a outfitly-api-staging`, and from the repo root `fly deploy . --config apps/api/fly.toml --dockerfile apps/api/Dockerfile`. Check: open `https://outfitly-api-staging.fly.dev/v1/health` → `{"status":"ok"}`.
- **Supabase JWT signing keys** — in Supabase → Project Settings → JWT Keys, make sure the project uses the new asymmetric signing keys (ECC/RSA; default for new projects). The API does not accept the old shared-secret (HS256) tokens.
- **Sentry** — create a free Sentry account/project "outfitly-api" (EU region) and share the DSN.
- **Cloudflare R2 + image domain (Step 1.4):** in Cloudflare, create two R2 buckets in the EU jurisdiction: `outfitly-originals-dev` (private) and `outfitly-public-dev` (connect the custom domain `img.<your domain>` to it; needs the domain on Cloudflare). Create an R2 API token with Object Read & Write on both. Share Account ID, Access Key ID and Secret. Claude then runs `pnpm media:try` with a real iPhone photo (prints 3 links to open in the browser) and also checks that R2 refuses an upload whose size/type doesn't match the link.
- **A real iPhone photo** (taken somewhere neutral, location on) to add as a test file, so tests use a true iPhone capture.
- **Expo / EAS (Step 1.5):** create a free Expo account, then (or let Claude, with an Expo access token): `cd apps/mobile && npx eas-cli@latest login && npx eas-cli init` (prints the project ID — Claude will put it and the owner into `app.config.ts`), `npx eas-cli device:create` to register your iPhone (needed for internal iOS builds; needs the Apple Developer account), then `npx eas-cli build --profile development --platform all` and install from the links on both phones. Run the Maestro tab test (`apps/mobile/.maestro/tabs.yaml`) on a preview build.
- **Sentry for the app:** create a Sentry project "outfitly-app" (EU), share the DSN, and add a Sentry auth token as an EAS secret (`SENTRY_AUTH_TOKEN`) so crash reports point at real code lines. Builds work without it.
- **OK for app libraries (Step 1.5), all free/open source and standard in Expo apps:** `i18next` + `react-i18next` + `expo-localization` (translations), `expo-crypto` (unique keys), `@tanstack/react-query-persist-client` + `@tanstack/query-async-storage-persister` (cache on the phone), `react-native-nitro-modules` (needed by MMKV), `expo-dev-client` (development builds), `@expo/vector-icons` (tab icons on Android), `eslint-plugin-react-hooks` (lint), and allowing `@sentry/cli`'s install step (it downloads the Sentry upload tool).
- **OK for photo libraries (Step 1.4):** `heic-decode` (reads iPhone HEIC; bundles the libde265 HEVC decoder — HEVC is patent-licensed, which is why the standard image library leaves it out) and the AWS S3 client (`@aws-sdk/client-s3` + presigner; talks to R2). Alternative to HEVC on the server: the app converts photos to JPEG on the phone before upload (planned anyway in Step 4.2).
- **API machine size:** decoding a 12 MP HEIC peaks ~550 MB, so the API machine is set to 1 GB (staging sleeps when idle, so ~free; always-on would be ~$5.70/month instead of ~$3.20).
- **Photo originals keep location data** (only the public sizes are stripped). Decide how long to keep originals (GDPR): e.g. delete after 30 days, or strip on arrival.
- **OK for two small free libraries (Step 1.3)** — `jose` (checks Supabase login tokens) and `@fastify/rate-limit` (rate limiting). Both are free, open source, widely used. Say no and Claude will replace them.

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
- Web shop clicks from logged-out visitors (Step 3.7) need a session-scoped idempotency key; include the active profile in the request fingerprint once Step 1.6 adds it.
- Replayed idempotent responses don't restore headers such as `Location`.
- Replace Expo's placeholder app icon and splash with the Outfitly logo (before Step 5.6).
- App writes: keep one idempotency key per user action through retries and the offline queue (helper when the first mutation lands, Step 2.4); let TanStack Query cancel requests (pass its AbortSignal).
- Clean up abandoned uploads: `pending` media rows and originals older than a day.
- Measure photo processing on the real Fly machine (target < 10 s; 1.7 s on GitHub's runner, 0.6 s on a Mac).
- Production (Phase 5): keep at least one API machine always on so the 03:17 cleanup and other jobs run (staging sleeps when idle).
- Pin GitHub Actions to commit SHAs (with Dependabot to keep them current); consider moving to `pnpm/setup` and pnpm 12.
