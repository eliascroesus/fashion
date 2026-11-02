# Outfitly — rules for Claude Code

## What we're building
Outfitly is Pinterest for outfits where everything is shoppable. Users scroll a two-column feed of complete looks; tapping one shows every piece (top, trousers, shoes, bag) with brand, price and a Shop button. Anyone can post looks and tag products (AI does most of the tagging). Accounts work like Instagram: personal, creator (stats, link-in-bio) or business/brand (brand page, Products tab, stats), switchable anytime, and one login can run several profiles.

Goal right now: user growth with a Pinterest-grade UX at minimal running cost. Money (commissions, boosts, ads, in-app checkout) comes later; the data model already leaves room for it.

- Full plan, phases and steps: `docs/BUILD_PLAN.md`
- Where we are: `docs/PROGRESS.md`
- Version 1 = Phases 1–5. Phases 6–9 are expansion and must NOT be built before V1 ships.

## How every session works
Elias (the founder) is not an engineer. He starts each session with `/start-phase N` (works through a phase step by step, pausing after each step) or `/start-step X.Y` (one step). If he just writes something like "start phase 2" or "continue", treat it as `/start-phase` for that phase and pick up from `docs/PROGRESS.md`. Every step follows the ritual below, one step at a time, never several steps at once.
1. Read this file, ONLY the current step in `docs/BUILD_PLAN.md` (plus anything it references), and `docs/PROGRESS.md`.
2. Plan mode first: list files to create/change, migrations, new packages, and the test plan. Wait for approval.
3. Build ONLY the current step. Ideas for later go to `docs/PROGRESS.md` under "Later".
4. Finish green: `pnpm typecheck`, `pnpm lint`, `pnpm test` all pass. Report every "Done when" item as PASS/FAIL with evidence.
5. Run the `step-reviewer` sub-agent on your changes; fix what it finds.
6. Explain in plain language how Elias tests it on his phone or in the browser.
7. Update `docs/PROGRESS.md` (done, decisions, known issues, measured numbers, next step), commit on branch `phase-X-step-X-Y`, push and open a pull request.

If stuck after 2 attempts: stop, write the blocker in `docs/PROGRESS.md`, and explain the options to Elias in plain language.

## Locked stack (do not change without Elias's explicit OK)
- Monorepo: pnpm workspaces + Turborepo, TypeScript strict everywhere, ESLint + Prettier, GitHub Actions CI.
- `apps/mobile`: Expo (latest stable SDK at Phase 1 start) + Expo Router, FlashList (masonry), Reanimated + Gesture Handler, expo-image (thumbhash placeholders), TanStack Query + MMKV, expo-web-browser for shop links. EAS builds.
- `apps/api`: Node 22 + Fastify, REST under `/v1`, zod validation, pg-boss jobs (connect via Supabase direct/session connection, never the transaction pooler). The ONLY writer to the database.
- `apps/web`: Next.js App Router, server-rendered public pages (must work with JavaScript off) + `/admin`.
- `services/embedder`: Python FastAPI + Marqo-FashionSigLIP (image or text in, vector out). Shared-secret auth.
- `packages/db`: Drizzle schema + migrations. Supabase Postgres (Stockholm) with pgvector, full-text search, pg_trgm. Row Level Security on, no client access.
- `packages/shared`: zod schemas, types, constants (categories, tags, event names). `packages/ui-tokens`: colours, type, spacing.
- Auth: Supabase Auth. Anonymous session created at the FIRST SAVE only (never at app open); upgrade via Apple / Google / email keeps the same user id (manual linking on, CAPTCHA on anonymous sign-ins).
- Media: Cloudflare R2 + Cloudflare CDN. Sizes 1080/600/300 WebP made once at upload with `sharp`; strip EXIF/GPS; store width, height, thumbhash, dominant colour. Never serve originals. Immutable URLs.
- AI: Gemini Flash-Lite with structured JSON output for garment spotting, descriptions and safety flags. Log model, prompt version and cost per call. Daily spend cap.
- Hosting: Fly.io region `arn` (Stockholm) for api, web, embedder; separate staging and production.
- Analytics: own `events` table + daily rollups; PostHog EU for key events only, after consent. Errors: Sentry everywhere.
- Tests: Vitest (api, shared, db), Playwright (web), Maestro (mobile flows).

## Non-negotiable rules
- No new paid service or dependency outside this list without asking Elias first. Low running cost is a product requirement.
- Accounts: a login (auth user) is NOT a profile. Every action (post, save, follow, click, board) is done AS the active profile (`profile_id`), resolved server-side from `profile_members`. Never key user content on the auth user id.
- Every DB change is a Drizzle migration; keep the data-model table in `docs/BUILD_PLAN.md` in sync.
- No secrets in code. `.env` (never committed) + Fly / EAS secrets. Keep `.env.example` current.
- Every client write sends an idempotency key; the server handles retries without duplicates.
- Feeds use cursor pagination, 20 per page. Never offset pagination.
- Every image list uses FlashList + expo-image with known width/height and a thumbhash placeholder. No layout jumps.
- Every user-visible string goes through i18n files (English first, Swedish ready). No hard-coded colours: use ui-tokens.
- Shop links open in expo-web-browser (SFSafariViewController / Chrome Custom Tabs), never the retailer's app. Keep the poster's affiliate parameters intact. Log a `clicks` row first.
- Log impressions with feed position and shop clicks, and keep `looks.is_sponsored`: these power future ads.
- Any server fetch of an external URL: SSRF protection (block private IPs), timeouts, size limits.
- Talk to Elias in plain language. Engineering detail goes in code, commits and PR descriptions.
