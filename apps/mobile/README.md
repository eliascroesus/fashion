# apps/mobile

Expo (SDK 58) + Expo Router app for iOS and Android.

- Screens live in `src/app` (`(tabs)` = Home, Search, Create, Saved, Profile). Colours and sizes come from `@outfitly/ui-tokens` through `src/theme`; every visible word comes from `src/i18n/en.json` / `sv.json` (lint blocks colour literals and raw JSX text).
- `src/api` is the typed API client (shared zod schemas, idempotency key on every write); TanStack Query caches responses in MMKV (`src/lib`).
- Builds: `eas build --profile development|preview|production`. Development builds use the app id `com.outfitly.app.dev`.
- Checks: `pnpm --filter @outfitly/mobile bundle` (iOS + Android JS bundles), `doctor`, and Maestro flows in `.maestro/` on a device.
- Settings (`.env` / EAS env): `EXPO_PUBLIC_API_URL`, `EXPO_PUBLIC_SENTRY_DSN`, `EAS_PROJECT_ID`, `SENTRY_ORG`, `SENTRY_PROJECT`.
