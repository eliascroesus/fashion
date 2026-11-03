# apps/mobile

Expo (SDK 58) + Expo Router app for iOS and Android.

- Screens live in `src/app` (`(tabs)` = Home, Search, Create, Saved, Profile). Colours and sizes come from `@outfitly/ui-tokens` through `src/theme`; every visible word comes from `src/i18n/en.json` / `sv.json` (lint blocks colour literals and raw JSX text).
- `src/api` is the typed API client (shared zod schemas, idempotency key on every write); TanStack Query caches responses in MMKV (`src/lib`).
- Builds: `eas build --profile development|preview|production`. Development builds use the app id `com.outfitly.app.dev`.
- Checks: `pnpm --filter @outfitly/mobile bundle` (iOS + Android JS bundles), `doctor`, and Maestro flows in `.maestro/` on a device.
- Saving (`src/saves`): every save, board change and "see less" goes into an outbox on the phone (MMKV) and is sent in order with its own Idempotency-Key, retried every 2 s → 30 s and when the app comes back. Screens show the outcome at once (waiting actions win over cached server data). The first save while logged out makes the guest session and opens the sign-up sheet.
- Developer menu (long-press the Profile title): "Waiting to sync" count; in every build but the store one also "Pretend offline" (requests fail like airplane mode) and a test login (email + password) in the sign-up sheet, for Maestro.
- Maestro, on the iPhone simulator with a Release build of the development app (no dev server needed):
  - `maestro test -e APP_ID=com.outfitly.app.dev apps/mobile/.maestro/home-grid.yaml`
  - `maestro test -e APP_ID=com.outfitly.app.dev apps/mobile/.maestro/offline-saves.yaml`
  - `maestro test -e APP_ID=com.outfitly.app.dev -e TEST_EMAIL=… -e TEST_PASSWORD=… apps/mobile/.maestro/save-sign-up.yaml` (the test login from `.env`: `TEST_LOGIN_EMAIL` / `TEST_LOGIN_PASSWORD`)
- Expo project: `@eliascroesuss-team/outfitly` (id in `app.config.ts`).
- Settings: local runs read `apps/mobile/.env`; EAS builds read the project's EAS environment variables (`eas env:list --environment preview`), one set per build profile's `environment`: `EXPO_PUBLIC_SUPABASE_URL`, `EXPO_PUBLIC_SUPABASE_PUBLISHABLE_KEY`, `EXPO_PUBLIC_TURNSTILE_SITE_KEY`, `EXPO_PUBLIC_TURNSTILE_ORIGIN`, `EXPO_PUBLIC_SENTRY_DSN`, `SENTRY_ORG`, `SENTRY_PROJECT`. `EXPO_PUBLIC_API_URL` for preview builds is in `eas.json`.
