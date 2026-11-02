# Outfitly — progress

Claude Code updates this file at the end of every session.

## Current step
Phase 1, Step 1.2 — Database

## Done
- Step 1.1 — Project skeleton and safety net (PR #1). Monorepo (pnpm + Turborepo), strict TypeScript, ESLint + Prettier, Vitest, GitHub Actions CI on every pull request. CI green.

## Decisions made
<!-- - YYYY-MM-DD — decision — why -->
- 2026-11-02 — Version 1 = Phases 1–5 (feed, look page, saves/boards, products with prices, creator upload, personal/creator/business accounts, Google pages + link-in-bio). Swipe mode, push, bulk import, share-out and Save to Outfitly moved to Phases 6–8.
- 2026-11-02 — TypeScript pinned to 6.0.x — typescript-eslint supports TS <6.1 only, and TS 7 (native) drops the JS compiler API that Expo/Next tooling uses.
- 2026-11-02 — `globals` pinned to ~17.13 — 17.14 was published a day earlier and pnpm 11 blocks brand-new releases (supply-chain guard).
- 2026-11-02 — Elias asked Claude to work through Phase 1 and Phase 2 overnight without stopping. Each step still gets its own branch + PR, stacked on the previous step's branch; nothing is merged into `main` without Elias.

## Open decisions for Elias
- Domain name (outfitly.com or other)
- App ID (default `com.outfitly.app`)
- Dark or light theme by default (Step 5.3)
- English only or English + Swedish at launch (Step 5.3)
- 18+ only or teens allowed (Step 5.5)

## Known issues
- `main` has no branch protection yet, so a PR with a red check could still be merged (ask Elias to require the "Typecheck, lint, test" check).
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
- Pin GitHub Actions to commit SHAs (with Dependabot to keep them current); consider moving to `pnpm/setup` and pnpm 12.
