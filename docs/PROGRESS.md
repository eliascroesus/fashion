# Outfitly — progress

Claude Code updates this file at the end of every session.

## Current step
Phase 1 gate (all six steps built; gate items wait on Elias's accounts and phones). Next: Phase 2, Step 2.1 — Looks in the database + seed loader.

## Done
- Step 1.1 — Project skeleton and safety net (PR #1). Monorepo (pnpm + Turborepo), strict TypeScript, ESLint + Prettier, Vitest, GitHub Actions CI on every pull request. CI green.
- Step 1.2 — Database (PR #2) — **done, including the live Supabase project (2026-11-02).** Drizzle schema + migrations for `profiles`, `profile_members`, `media`, `feature_flags`; pgvector + pg_trgm; RLS on every table with no policies, and Supabase's API roles (anon / authenticated / service_role) have their access revoked for existing and future tables and functions. Seed script. Tests run on a real Postgres 17 + pgvector locally and in CI. Live on `outfitly-dev` (Stockholm, Postgres 17.11): 4 migrations applied, seed loaded, live test 5/5 (publishable key gets 401/42501 on every table), RLS on all 5 tables with 0 policies, 0 grants to anon/authenticated/service_role, postgres-owned default privileges grant nothing to the API roles, vector 0.8.2 + pg_trgm 1.6 in `extensions`, non-TLS connections refused, TLS verified against the Supabase root CA, signing keys ES256, GraphQL (pg_graphql) not enabled.
- Step 1.3 — Backend skeleton (PR #3) — **done, live on Fly staging (2026-11-02).** Fastify API under `/v1`: `/v1/health`, `/v1/me` (login required), zod on every route (startup fails without response/body/params schemas), one error format, request ids + logs, Sentry (5xx only, no personal data), Supabase login check incl. guest tokens (503 if Supabase's keys can't be fetched), idempotency keys on every logged-in write (new `idempotency_keys` table), rate limiting per phone, pg-boss with a test job and a daily cleanup job. Dockerfile + `fly.toml` for `outfitly-api-staging` in Stockholm; CI builds the image, runs migrations in it, starts it and checks health / 401 / test job. Live at https://outfitly-api-staging.fly.dev (one 1 GB machine in `arn`, sleeps when idle): release command applied migrations over TLS, `/v1/health` → 200 `{"status":"ok"}`, `/v1/me` → 401 logged out and 401 for a forged ES256 token (so the Supabase signing keys are fetched), pg-boss ran the startup ping job. Sentry on (EU, org `elias-andersson`, project `outfitly-api`): a test error sent from the live machine was delivered.
- Step 1.4 — Photo pipeline (PR #4) — **done, including real Cloudflare R2 (2026-11-02).** Upload flow: ask for a link → upload the original straight to R2 → say done → a background job makes 1080/600/300 WebP (location/camera data removed, iPhone Display P3 colours converted to sRGB, HEIC supported) plus size, blurry preview (thumbhash) and main colour. Unsafe files (decompression bombs, SVG/GIF/TIFF, strips) are refused from the header; processing runs in a worker thread; failed jobs are marked failed after retries. `pnpm media:try photo.heic` prints the 3 links. Live on R2 (EU jurisdiction buckets `outfitly-originals-dev` private, `outfitly-public-dev` on its r2.dev address): 12 MP HEIC processed in 1.64 s from the Mac, 3 public WebP links return 200 `image/webp` with `immutable` caching and no location data; R2 refuses an upload link used with the wrong size, wrong type or no type (403); originals are not reachable publicly or without a signature.
- Step 1.5 — App shell (PR #5) — **code done and bundles build in CI; running on phones waiting on Elias (Expo account + phones).** Expo SDK 58 app with five icon-only tabs (filled when active, named for screen readers), warm light + dark themes from `packages/ui-tokens` (contrast-tested), English + Swedish texts, typed API client, TanStack Query cached in MMKV, Sentry, translated error screen, EAS profiles (development / preview / production). Lint blocks hard-coded colours and untranslated text in the app.
- Step 1.6 — Login plumbing (PR #6) — **code done and tested; real sign-in waiting on Elias (Supabase, Apple, Google, Turnstile, phones).** Server: `POST /v1/session` gives every login (guests too) a personal profile with a `user1234`-style handle and makes it active; `GET /v1/me`; requests name the profile they act as (`X-Profile-Id`, checked against `profile_members`); `POST /v1/session/merge-guest` moves a guest's content into an existing account (checks the guest is still a guest in the database). App: Supabase login (session saved on the phone), guest session only on demand (first save / "Test save"), Apple (native), Google and email code — a guest upgrading keeps the same account; if the Apple ID / Google account / email already has an account, the guest's data moves over (retried if offline). Sign out on this phone only. Reusable "sign up to save" sheet; Profile tab with a hidden developer menu (long-press the title → "Test save"). CAPTCHA via Cloudflare Turnstile.

## Decisions made
<!-- - YYYY-MM-DD — decision — why -->
- 2026-11-02 — Staging runs on a single Fly machine (`fly deploy --ha=false`); production gets two (Phase 5).
- 2026-11-02 — R2 buckets in the EU jurisdiction (data stays in the EU); the API reaches them on the `.eu.` endpoint via `R2_JURISDICTION` (default `eu`).
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
- 2026-11-02 — New profiles get a neutral handle like `user4821` (never built from the email, which would expose it); people choose their own handle later (Step 4.x).
- 2026-11-02 — Sign out ends the session on this phone only; guests have no sign-out button (a guest account can't be signed back in to).
- 2026-11-02 — A guest whose Apple ID / Google account / email already has an account: sign in to that account, then the server moves the guest's content (photos now; saves, boards… in Phase 2 — a test fails if a new profile-owned table is forgotten). The guest's own login is left behind.
- 2026-11-02 — Elias asked Claude to work through Phase 1 and Phase 2 overnight without stopping. Each step still gets its own branch + PR, stacked on the previous step's branch; nothing is merged into `main` without Elias.

## Waiting on Elias
- **Fly billing:** add a credit card in the Fly dashboard (Billing); the $1 trial credit runs out within days.
- **A real iPhone photo** (the R2 check used the generated 12 MP test HEIC) (taken somewhere neutral, location on) to add as a test file, so tests use a true iPhone capture.
- **Expo / EAS (Step 1.5):** create a free Expo account, then (or let Claude, with an Expo access token): `cd apps/mobile && npx eas-cli@latest login && npx eas-cli init` (prints the project ID — Claude will put it and the owner into `app.config.ts`), `npx eas-cli device:create` to register your iPhone (needed for internal iOS builds; needs the Apple Developer account), then `npx eas-cli build --profile development --platform all` and install from the links on both phones. Run the Maestro tab test (`apps/mobile/.maestro/tabs.yaml`) on a preview build.
- **Sentry for the app:** project `outfitly-app` (EU) exists and its DSN is in `apps/mobile/.env` (2026-11-02). Optional: add a Sentry auth token as an EAS secret (`SENTRY_AUTH_TOKEN`) so crash reports point at real code lines. Builds work without it.
- **Supabase login settings (Step 1.6)** — done 2026-11-02: anonymous sign-ins, manual linking, redirect URLs (`outfitly://auth-callback`, `outfitly-dev://auth-callback`), CAPTCHA (Turnstile, widget hostname `outfitly-api-staging.fly.dev`; a guest sign-up without a token gets 400 `captcha_failed`). Still to add once those accounts exist:
  - Apple provider: add the app ids `com.outfitly.app` and `com.outfitly.app.dev` as client IDs (needs the Apple Developer account: enable "Sign in with Apple" for both app ids).
  - Google provider: create a Google Cloud OAuth client (Web, redirect `https://<project-ref>.supabase.co/auth/v1/callback`), paste its Client ID and Secret.
  - Email templates: parked, see `docs/BEFORE_LAUNCH.md`.
- **OK for login libraries (Step 1.6):** `@supabase/supabase-js` (Supabase login, in the stack), `expo-apple-authentication` (native Apple sign-in), `react-native-webview` + Cloudflare Turnstile (free CAPTCHA that Supabase requires for guest sign-ins).
- **OK for app libraries (Step 1.5), all free/open source and standard in Expo apps:** `i18next` + `react-i18next` + `expo-localization` (translations), `expo-crypto` (unique keys), `@tanstack/react-query-persist-client` + `@tanstack/query-async-storage-persister` (cache on the phone), `react-native-nitro-modules` (needed by MMKV), `expo-dev-client` (development builds), `@expo/vector-icons` (tab icons on Android), `eslint-plugin-react-hooks` (lint), and allowing `@sentry/cli`'s install step (it downloads the Sentry upload tool).
- **OK for photo libraries (Step 1.4):** `heic-decode` (reads iPhone HEIC; bundles the libde265 HEVC decoder — HEVC is patent-licensed, which is why the standard image library leaves it out) and the AWS S3 client (`@aws-sdk/client-s3` + presigner; talks to R2). Alternative to HEVC on the server: the app converts photos to JPEG on the phone before upload (planned anyway in Step 4.2).
- **API machine size:** decoding a 12 MP HEIC peaks ~550 MB, so the API machine is set to 1 GB (staging sleeps when idle, so ~free; always-on would be ~$5.70/month instead of ~$3.20).
- **OK for two small free libraries (Step 1.3)** — `jose` (checks Supabase login tokens) and `@fastify/rate-limit` (rate limiting). Both are free, open source, widely used. Say no and Claude will replace them.

## Open decisions for Elias
- Domain name (outfitly.com or other) — none yet (2026-11-02); everything that waits on it is in `docs/BEFORE_LAUNCH.md`; outfitly.com is registered by someone else (since 2011). Until we have one, images use the R2 public dev address (r2.dev — rate-limited and meant for development, so connect `img.<domain>` as a Custom Domain on `outfitly-public-dev` and update `MEDIA_PUBLIC_BASE_URL` before launch) and Turnstile allows `outfitly-api-staging.fly.dev` (`EXPO_PUBLIC_TURNSTILE_ORIGIN`)
- App ID (default `com.outfitly.app`)
- Dark or light theme by default (Step 5.3)
- English only or English + Swedish at launch (Step 5.3)
- 18+ only or teens allowed (Step 5.5)

## Known issues
- Parked until before launch (domain, email-code login, store polish, privacy, production servers): `docs/BEFORE_LAUNCH.md`.
- On Supabase, objects created by `supabase_admin` (Supabase's own platform role, not us) in `public` still get default grants for the API roles; we can't change that role's defaults. Our tables are created by `postgres`, and RLS with no policies blocks rows regardless.
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
- Photo processing, 12 MP HEIC → 3 WebP sizes on real R2 (from the Mac): 1.64 s (2026-11-02)
- Staging API: image 110 MB; new machine created and started in 7.8 s, server listening ~5 s after boot; `/v1/health` round trip from Stockholm-area Mac 76 ms; waking a sleeping staging machine 8.3 s (2026-11-02)

## Later (parked ideas, not in current scope)
- Staging: try `auto_stop_machines = "suspend"` instead of `"stop"` so a sleeping machine wakes in well under a second instead of ~8 s (nicer for phone testing; same cost).
- Open the same look after a fresh install (deferred deep link)
- Relax `globals` back to `^17` once 17.14 is a few days old.
- Handles: release a soft-deleted profile's handle after a while; block `..` / leading/trailing dots; reserved-handle list (Step 4.x).
- Consider turning off Supabase's Data API (REST) entirely as a third lock (then adjust the live test).
- Web shop clicks from logged-out visitors (Step 3.7) need a session-scoped idempotency key; include the active profile in the request fingerprint once Step 1.6 adds it.
- Replayed idempotent responses don't restore headers such as `Location`.
- Delete leftover guest logins (anonymous auth users with no profile) with a scheduled job (needs the Supabase admin key).
- App writes: keep one idempotency key per user action through retries and the offline queue (helper when the first mutation lands, Step 2.4); let TanStack Query cancel requests (pass its AbortSignal).
- Clean up abandoned uploads: `pending` media rows and originals older than a day.
- Measure photo processing on the real Fly machine (target < 10 s; 1.7 s on GitHub's runner, 0.6 s on a Mac).
- Pin GitHub Actions to commit SHAs (with Dependabot to keep them current); consider moving to `pnpm/setup` and pnpm 12.
