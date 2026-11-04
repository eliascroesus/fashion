# Before launch

Things we've parked on purpose. None of them block building, but all of them must be done before real users (testers or the App Store) get the app. Tick them off here as they're done.

## Domain
- [ ] Pick and buy a domain. outfitly.com is registered by someone else (since 2011). Cloudflare sells domains at cost (about $10/year for a .com).
- [ ] Photos: connect `img.<domain>` as a Custom Domain on the public R2 bucket (R2 → bucket → Settings → Custom Domains) and set `MEDIA_PUBLIC_BASE_URL` to it. Today we use the bucket's temporary `pub-….r2.dev` address, which Cloudflare rate-limits and only meant for development.
- [ ] CAPTCHA: add the domain as a hostname on the Turnstile widget "Outfitly app" and set `EXPO_PUBLIC_TURNSTILE_ORIGIN=https://<domain>`. Today it uses `outfitly-api-staging.fly.dev`.
- [ ] Google login: put the domain, a privacy policy link and a logo on the Google Auth Platform screen and publish the app (it's in "Testing" mode, where only listed test users can log in).
- [ ] A privacy policy and terms page on the domain (Apple and Google both ask for the links).
- [ ] Google's account picker says "to continue to uvxsniutadtpyfmmzhdq.supabase.co". To show our own address instead, Supabase offers a custom domain (e.g. `auth.<domain>`) as a paid add-on. That's a new cost, so Elias decides; otherwise it stays as is.

## Email login (6-digit code)
- [ ] Choose an email-sending service (for example Resend or Postmark; both have free tiers). It's a new service, so Elias decides. It needs the domain above to send from.
- [ ] Supabase → Authentication → Emails → **Set up SMTP** with that service.
- [ ] Then edit the templates "Confirm sign up", "Magic Link" and "Change Email Address": subject "Your Outfitly code", and a body that shows the code `{{ .Token }}`. Without this, people get a link instead of a code and email login doesn't work.
- [ ] Until it's done, the app's "Continue with email" option doesn't work: hide it or finish this before testers.

## Content
- [ ] The seed photos (loaded 2026-11-04 as `@outfitly.picks`) look saved from Pinterest and Instagram. Before anyone outside the team sees them: get each owner's permission (and credit them), or replace them with photos we may use.

## The app
- [ ] Hide the developer menu (long-press the Profile title) in store builds. Its "Pretend offline" switch and the test login in the sign-up sheet are already left out of store builds (`EXPO_PUBLIC_APP_ENV=production`); only the "Waiting to sync" count would still show.
- [ ] Replace Expo's placeholder app icon and splash screen with the Outfitly logo.
- [ ] Keep the login session encrypted on the phone (MMKV encryption key stored in the secure keychain).

## Privacy
- [ ] Decide how long to keep original photos, which still contain location data (suggestion: delete after 30 days). Only the public sizes are cleaned today.

## Servers (Phase 5)
- [ ] Separate production Supabase project, R2 buckets and Fly app (everything so far is "dev" / "staging").
- [ ] Keep at least one production API machine always on, so the nightly clean-up and other background jobs run (staging sleeps when idle).

## GitHub
- [ ] Make the code repository private.
- [ ] Protect `main` so nothing can be merged unless its checks are green.
