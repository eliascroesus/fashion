# Outfitly — Build Plan for Claude Code

Nov 2, 2026 · @Elias Andersson

## What Outfitly is

**Outfitly is Pinterest for outfits where you can buy everything you see.** You scroll a feed of complete looks, tap one, and see every piece in it (top, trousers, shoes, bag) with its brand, price and a button to buy it. Pinterest gives inspiration with no way to buy; Amazon and Zalando sell items with no styling. Outfitly is the bridge: *inspiration you can shop*.

**The unit is a whole outfit, not a single product.** People get dressed in outfits, so the app sells "this look" and lets you buy the full look or only the pieces you don't own yet.

### How it works, for each kind of user

**Shopper (most users).**

1. Opens the app and sees a feed straight away, with no sign-up.
2. Swipes through 8–10 looks in a 30-second taste picker, which tunes the feed.
3. Scrolls a two-column grid of looks.
4. Taps a look. A big photo shows dots on each garment, with the list of pieces and prices underneath ("Total look €392").
5. Below the look, an endless "more like this" feed keeps going.
6. Taps save. On the first save it asks to sign up with Apple or Google, and the save is kept.
7. Organises saves into boards (Summer, Work, Wedding guest).
8. Taps "Shop" on a piece, and the shop opens inside the app to buy.
9. Shares a look to Instagram or TikTok, or saves outfits she sees elsewhere with "Save to Outfitly". The AI then finds the pieces, like *Shazam for outfits*.

**Creator (anyone who posts).**

1. Uploads a photo of an outfit.
2. The AI spots each garment and suggests the matching products.
3. She confirms them or pastes her own links, keeping her own affiliate tags so she keeps her commission.
4. The look goes live after an automatic link check.
5. She gets a link-in-bio page (outfitly.com/@name), stats, followers, and notifications like "your look was saved 25 times".

**Brand.** Gets a brand page that fills itself with every look containing its products. It uploads lookbooks and products, and the AI tags them. Paid boosts and ads come later.

**Accounts work like Instagram.** Everyone starts with a personal account. In settings you can switch it to a **creator** account (stats on every look, link-in-bio page) or a **business / brand** account (brand page, Products tab, stats), and back again without losing anything. One login can also run several profiles, for example a personal one and a brand. Hold the Profile tab to switch between them.

### Inspiration: what we copy from whom

| From | What we copy |
| --- | --- |
| **Pinterest** | The calm image-first grid, saving to boards, endless "more like this", a web page for every pin that Google finds |
| **LTK / ShopMy** | Creators posting looks with tagged products and earning on every sale; link-in-bio pages |
| **Amazon** | Every product has a price, availability and a buy button; shopping feels trustworthy |
| **TikTok / Instagram** | Full-screen swipe mode, follows, creator-driven growth |
| **Whatnot** (later) | Renting payments and live video instead of building them |

### The core loop the whole build serves

**Discover → save → come back → share → new people discover.** Buying sits inside that loop, but the first goal is users and habit. The key number is **people who save a look each week**. Every phase below either makes this loop work, makes it feel better, or brings more people into it.

### Where it's going

Fashion first in Sweden and the Nordics, then wider Europe and the US. Later come other categories (home, beauty), brand ads and boosts, checkout inside the app, and live shopping drops. The build leaves room for all of this without building it now.

## How to build this with Claude Code

Every phase is split into numbered **steps**. **One Claude Code session builds one step**, then stops. Small steps with a written checklist are what keep errors out: Claude Code never has to hold the whole app in its head, and you check each piece on your phone before the next one starts.

### Three files live in the project, and Claude Code reads them every session

| File | What it holds | Who updates it |
| --- | --- | --- |
| `CLAUDE.md` | The rules and locked stack (already in the GitHub repo). Claude Code reads it automatically. | Rarely, and only when you agree a change |
| `docs/BUILD_PLAN.md` | This document, exported as Markdown | You, when the plan changes |
| `docs/PROGRESS.md` | Which steps are done, what's next, decisions made, known bugs | Claude Code, at the end of every session |

### The session ritual (same every time)

1. **Start a fresh session** and paste the start prompt below with the step number.
2. **Claude Code plans first.** It reads the three files and the existing code, then writes a short plan. No code until you say go.
3. **You approve the plan** (or ask why). If the plan touches anything outside the step, push back.
4. **It builds, then proves it works.** It runs type checks, lint and automated tests, and fixes anything red.
5. **A fresh pair of eyes:** it asks a review sub-agent to check the work against the step's checklist.
6. **You test it on your phone** using the step's "How Elias checks it" line.
7. **It updates PROGRESS.md, commits and opens a pull request.** You merge, and the next step starts in a new session.

**Start a step with one command.** The GitHub repo [eliascroesus/fashion](https://github.com/eliascroesus/fashion) has shortcuts built in. In Claude Code, type:

- `/status`: where we are, what's next, what you need to provide
- `/start-step 2.3`: runs the whole ritual above for that step
- `/stuck`: stop, explain in plain language, propose the smallest fix

A built-in `step-reviewer` agent does the fresh-eyes check at the end of every step. The full start prompt, in case you ever need it without the shortcut:

```text
We are building Outfitly. Read CLAUDE.md, docs/BUILD_PLAN.md and docs/PROGRESS.md first.
Today's task: Phase 2, Step 2.3 only.
1. Use plan mode. Read the existing code that this step touches, then show me a short plan: files you will create/change, database changes, new packages (if any), and how you will test it. Wait for my OK.
2. Build it. Follow the locked stack in CLAUDE.md. Do not build anything from later steps.
3. Run typecheck, lint and tests until all pass. Run the step's acceptance checklist and report each item as PASS/FAIL with evidence.
4. Spawn a review sub-agent to check your diff against the step's checklist and CLAUDE.md rules; fix what it finds.
5. Tell me exactly how to test it on my phone in plain language.
6. Update docs/PROGRESS.md (done, decisions, known issues, next step), commit on a branch named phase-2-step-2-3, and open a PR.
```

**If something breaks mid-session (copy-paste):**

```text
Stop building. Explain in plain language what is broken, what you have tried, and the 2 most likely causes. Do not change unrelated code. Propose the smallest fix and wait for my OK.
```

### Ground rules Claude Code must follow (also in CLAUDE.md)

- **Build only the current step.** Ideas for later go into PROGRESS.md under "Later".
- **No new paid service or package outside the locked stack without asking first.** Cheap running costs are a product requirement.
- **Every database change is a migration file,** never a manual edit, and the data-model section is updated to match.
- **No secret keys in code.** They go in `.env` files (never committed) and the hosting secret settings.
- **Each step ends green:** type checks, lint and tests pass, and the acceptance checklist is all PASS.
- **If stuck for more than 2 attempts, stop** and write the blocker in PROGRESS.md instead of guessing.

### Your job in each session

- Approve plans.
- Test on your phone.
- Provide accounts and keys when a step asks for them (each phase lists what it needs).
- Decide anything marked **DECISION**.

## The locked stack and project layout

Every tool choice below is final for the MVP. That stops Claude Code from "improving" things mid-build, which is the most common source of breakage. The stack comes from the build review: cheapest smart option at each job, about $60–110 a month at launch.

| Area | Locked choice | Notes for Claude Code |
| --- | --- | --- |
| Mobile app | Expo (latest stable SDK at Phase 1 start) + Expo Router + TypeScript | Dev builds via EAS, not Expo Go, once native modules are added |
| Grid and lists | FlashList (masonry layout) | Never a plain ScrollView for feeds |
| Animation and gestures | Reanimated + Gesture Handler | Swipe deck and save animations run on the UI thread |
| Images in the app | expo-image with thumbhash placeholders | Always request the 300/600/1080 size that fits the screen |
| Data fetching | TanStack Query + MMKV storage | Optimistic saves, offline queue, cached last feed |
| Backend program | Node 22 + Fastify + TypeScript, REST under `/v1` | The only thing that writes to the database |
| Background jobs | pg-boss (job queue inside Postgres) | Image processing, AI tagging, link checks, price refresh, notifications |
| Database | Supabase Postgres, Stockholm, with pgvector, full-text search and pg\_trgm | Drizzle ORM for schema and migrations; Row Level Security on and closed to clients |
| Login | Supabase Auth: anonymous session created at first save, upgraded with Apple / Google / email | Never create guests at app open |
| Photos | Cloudflare R2 + Cloudflare CDN on a custom domain (img.outfitly…) | Sizes 1080/600/300 WebP made once at upload with `sharp`; URLs never change |
| AI: spotting garments | Gemini Flash-Lite with structured JSON output | Prompt versioned in code; results stored, never re-run needlessly |
| AI: visual fingerprints | Python mini-service (FastAPI + Marqo-FashionSigLIP) | One endpoint: image + optional crop box in, vector out |
| Web pages + admin | Next.js (App Router), server-rendered | Public look/board/creator pages, waitlist, `/admin` |
| Hosting | Fly.io, Stockholm region: api, web, embedder | Staging and production apps |
| Push notifications | expo-notifications + Expo push service | Free |
| Analytics | Own events table + PostHog EU for key events | PostHog only after consent |
| Errors | Sentry (app, api, web) | From Phase 1 |
| Tests | Vitest (api, shared), Playwright (web), Maestro (mobile flows) | Every step adds tests |
| Code home | GitHub monorepo, pnpm workspaces + Turborepo, GitHub Actions CI | CI runs typecheck, lint, tests on every pull request |

**Project layout:**

```text
outfitly/
  apps/
    mobile/        Expo app (iOS + Android)
    api/           Fastify backend + background jobs
    web/           Next.js: public pages, waitlist, /admin
  services/
    embedder/      Python: fashion fingerprint model
  packages/
    shared/        zod schemas, types, constants (categories, tags)
    db/            Drizzle schema, migrations, seed scripts
    ui-tokens/     colours, type scale, spacing shared by mobile + web
  docs/
    BUILD_PLAN.md  this document
    PROGRESS.md    living status file
  CLAUDE.md
```

**One data rule that prevents a whole class of bugs:** the app and the web pages never touch the database directly. They talk only to the backend, plus Supabase's login library. The backend checks every request, writes every row, and logs every event.

## Phase map

**Version 1 is deliberately small:**

- the feed
- the look page
- saving and boards
- the product list with prices
- creator upload
- Instagram-style personal / creator / brand accounts
- Google pages with link-in-bio

That is five phases and about 11 weeks, live around mid-January 2027. Everything else is added afterwards in two-week phases. Each phase only starts once the one before has passed its gate.

```text
Weeks 1-2    Phase 1  Foundations                 project, database, server, photos, login
Weeks 3-4    Phase 2  The Pinterest feel          grid feed, look page, saves, boards, search
Weeks 5-6    Phase 3  Products and AI             AI tagging, prices, Shop button, more like this
Weeks 7-9    Phase 4  Accounts, upload, Google    personal/creator/brand, posting, web pages
  -- Content gate (~3 Jan): 300+ shoppable looks, links verified --
Weeks 10-11  Phase 5  V1 launch                   production, test week, legal, store approval
  == VERSION 1 LIVE, mid-January 2027 ==
Then two weeks per phase, in the order users' numbers point to:
             Phase 6  Bring people back           push notifications, swipe mode, price-drop alerts
             Phase 7  Creators and brands pro     deeper analytics, bulk import, brand teams, Shopify sync, full admin
             Phase 8  Growth loops                links that open the app, Story shares, Save to Outfitly, invites
             Phase 9  Money                       commissions, boosted looks, ads, in-app checkout
```

The order is deliberate:

- **Phase 2 before Phase 3:** the feel comes before the shopping. If browsing isn't great, nothing else matters.
- **Accounts are planned in Phase 1** and switched on in Phase 4, so personal, creator and brand profiles never need a rebuild.
- **Google pages ship in V1** because search traffic compounds from day one.
- **Legal waits for Phase 5,** just before the store submission.

One Claude Code session = one step. Most phases have 5–9 steps.

## Data model v1

This is the full list of tables the MVP needs, so Claude Code designs Phase 1 with the end in mind and never has to restructure. Each table is created in the phase that first uses it. The fields that leave room for ads and checkout are built now and stay unused until later.

| Table | Holds | Why it exists | Phase |
| --- | --- | --- | --- |
| `profiles` | One row per profile: handle, name, avatar, **account type (personal / creator / business)**, creator category, brand name, logo and website (business), verified flag | Instagram-style accounts on one system; switch type anytime | 1 |
| `profile_members` | Which login owns or can act for which profile (owner / editor), and which profile is active | One login can run up to 5 profiles (personal + brand); brand teams later | 1 |
| `media` | Each uploaded photo: storage keys for original + 3 sizes, width, height, thumbhash, dominant colour, status, content type, size, error; for a look's photos, the AI reading (Step 3.3: spotting status and time, one-sentence description, search words, safety flags) and the whole-photo fingerprint (768 half-precision, HNSW cosine) with the model that made it | Grid never jumps; originals never shown; "more like this" | 1 |
| `feature_flags` | On/off switches per feature, optionally on only for listed tester profiles | Turn features on for testers first | 1 |
| `idempotency_keys` | Each client write's key (per login), request fingerprint and stored response; expires after 24 h | A double-tap or retry never creates duplicates | 1 |
| `looks` | A posted outfit: author profile, caption, status (draft / pending / published / hidden), slug, occasion, season and style tags (styles: `docs/STYLE_GUIDE.md`), AI description and AI search words (from its photos' AI reading), popularity score, **is\_sponsored**, published time (feeds sort on it), search words (tags, caption, AI description and AI search words; kept up to date by Postgres) | The core content unit; sponsored flag ready for ads later | 2 |
| `look_media` | Which photos belong to a look, in what order (up to 10) | Multi-photo looks | 2 |
| `taste_profiles` | Styles and brands picked in onboarding | Tunes the first feed | 2 |
| `saves`, `boards`, `board_items` | What each profile saved and how it organised it | The main habit metric | 2 |
| `swipes`, `seen` | Every skip and "see less"; what was shown in the last 7 days | Better feed now, AI ranking later | 2 |
| `events` | Every impression (with feed position), open, save, share, click, split by month (one partition per month, made ahead by a daily job; no foreign keys: events stay with the profile that made them) | Growth metrics and stats now, ad sales later | 2 |
| `follows` | Which profile follows which | Following feed, stats | 2 |
| `feed_snapshots` | The ranked list behind a For You scroll (up to 400 look ids): a profile's newest 5, or a few shared logged-out ones (per style choice picked on the phone: `taste_key`); deleted after a day | Pages never repeat or skip a look, even when scores change mid-scroll | 2 |
| `search_terms` | Search's vocabulary: every word in the looks that can be shown, with how many looks have it, plus Swedish words for tags (e.g. sommar → summer); rebuilt from the looks every 15 minutes | Typo tolerance ("linnen" finds linen), suggestions while typing, popular tags | 2 |
| `garments` | Each item the AI spotted in a photo: box (fractions of the photo), category (fixed list, `GARMENT_CATEGORIES` in `packages/shared`), colour, attributes (pattern, material, brand text…), fingerprint vector (768 half-precision numbers, Marqo-FashionSigLIP; HNSW index, cosine) and the model that made it | Dots on garments, search words, "more like this" | 3 |
| `products` | The item itself: brand, name, category, barcode (GTIN, unique), main image (the shop's link + our processed copy), fingerprint vector (768 half-precision, HNSW cosine) and the model that made it, owning business profile (if any) | "The same jacket" across shops; brands' Products tab | 3 |
| `offers` | Which shop sells a product: URL (the poster's link, affiliate tag kept; what Shop opens; up to 2 KB), the shop's product page it lands on (what price checks read, so a check is never an affiliate click), price in minor units (öre, cents), currency, stock (in stock / out of stock / unknown), last checked, price history | Prices, link checks, later commissions and checkout | 3 |
| `look_items` | Links a garment in a look to an offer (one row per look and offer): dot position (on one of the look's photos), match score, status (pending / verified / rejected) | The "shop the look" list | 3 |
| `link_checks` | Result of every automatic link check: similarity score, the AI's answer (yes / no / unsure) when asked, outcome (verified / review / rejected), reason code, thresholds used | Trust, review queue | 3 |
| `clicks` | Every tap to a shop: random click ID, profile or session, look, offer, author, feed position, screen, platform (iPhone / Android / web); no foreign keys, like `events` | Stats now, commissions later | 3 |
| `daily_stats` | Per-look and per-profile daily totals (views, opens, saves, clicks, visits) | Fast creator and business stats | 4 |
| `ai_calls` | Every paid AI call: purpose, model asked for and version that answered, prompt version, status (ok / blocked / invalid / failed), input, output and thinking tokens, cost (millionths of a dollar), time taken, photo and look; no foreign keys, like `events` | Cost per 1,000 photos; the daily spend cap | 3 |
| `moderation_queue` | Items waiting for review: kind (for now photos the AI flagged), photo, reasons, details (e.g. each hidden look's status before), status (open / approved / removed), when resolved, note; one open item per photo | Flagged photos are hidden until a person looks | 3 |
| `reports`, `blocks` | User reports, blocked profiles | Safety from day one of posting | 4 |
| `push_tokens`, `notifications` | Device tokens and every notification sent | Retention loop | 6 |
| `invites`, `shares` | Invite codes, shares and who brought whom | Growth loops | 8 |

**Rules:**

- Every table has `id` (UUID), `created_at` and `updated_at`.
- Deletes are soft, using a `deleted_at` column, for anything a user can remove.
- Every write carries an idempotency key from the app, so a double-tap or retry never creates duplicates.

## Phase 1 — Foundations

**Goal:** an empty but rock-solid base. By the end, the project exists, the database is live, the backend runs on a real server, photos can be uploaded and resized, and the app installs on your phone with login working. Nothing users see yet, but every later phase stands on this.

**Target:** weeks 1–2.

**You provide before Step 1.1:**

- a GitHub organisation
- Supabase, Cloudflare, Fly.io, Sentry and Expo accounts
- the domain (**DECISION:** outfitly.com or similar)
- Apple Developer account for the company (needs a D-U-N-S number; start today)
- Google Play Console

### Step 1.1 — Project skeleton and safety net

- Create the monorepo exactly as in the layout above: pnpm workspaces, Turborepo, strict TypeScript, ESLint + Prettier, Vitest.
- GitHub Actions runs typecheck, lint and tests on every pull request.
- Keep the `CLAUDE.md`, `docs/` and `.claude/` files already in the repo. Add `.env.example` and a "how to run" section to the README.
- **Done when:** `pnpm typecheck && pnpm lint && pnpm test` passes locally and in CI.
- **How Elias checks it:** the pull request on GitHub shows a green tick.

### Step 1.2 — Database

- Supabase dev project (production comes in Phase 5), Stockholm region. Turn on pgvector and pg\_trgm.
- Drizzle in `packages/db`. First migration (profiles are separate from logins, so one login can own several profiles, see Step 4.1): profile\_members, `profiles`, `media`, `feature_flags`.
- Row Level Security on every table with no client access.
- Seed script for local test data.
- **Done when:** migrations apply to an empty database from scratch, and a test proves the public app key cannot read any table.
- **How Elias checks it:** tables visible in the Supabase dashboard.

### Step 1.3 — Backend skeleton, live on a server

- Fastify app with:
  - `/v1/health`
  - zod validation on every route
  - one error format
  - request logging and Sentry
  - login check that accepts Supabase tokens, including anonymous ones
  - idempotency-key handling
  - basic rate limiting
  - pg-boss with a test job, connected through Supabase's direct/session connection, not the transaction pooler, which breaks job queues
- Deploy to a Fly.io staging app in Stockholm with secrets set there.
- **Done when:** the staging health URL returns OK, protected routes return 401 without login, and the test job runs.
- **How Elias checks it:** open the staging URL ending in `/v1/health` and see `ok`.

### Step 1.4 — Photo pipeline

- Two R2 buckets: private originals and public sizes. Public sizes are served through Cloudflare on `img.` + your domain.
- Upload flow:
  1. The app asks the backend for an upload link.
  2. The app uploads the original straight to R2.
  3. The app tells the backend it's done.
  4. A background job makes 1080/600/300 WebP versions and strips location and camera data.
  5. The job stores width, height, thumbhash and dominant colour.
- Long cache headers; file names never reused. Handle iPhone HEIC photos.
- **Done when:** a 12-megapixel iPhone photo becomes 3 sizes in under 10 seconds with GPS data removed, and tests cover it.
- **How Elias checks it:** a test script prints 3 image links that open in the browser.

### Step 1.5 — App shell

- Expo Router app with five icon-only tabs, filled when active (design discussion): Home, Search, Create, Saved, Profile.
- Colour, type and spacing tokens from `packages/ui-tokens`, with a warm light theme and a dark theme. No hard-coded colours. All on-screen text goes through translation files (English first, Swedish ready).
- Typed API client, TanStack Query with MMKV storage, Sentry.
- EAS build profiles: development, preview, production. App ID `com.outfitly.app` (**DECISION** if different).
- **Done when:** a development build runs on your iPhone and an Android phone, and the tabs navigate smoothly.
- **How Elias checks it:** install from the EAS link on your phone.

### Step 1.6 — Login plumbing

- Supabase Auth in the app: Sign in with Apple (native), Google, and email code.
- A reusable "sign up to save" sheet, plus the function that creates an anonymous session on demand. It is called only at the first save, in Phase 2.
- Upgrading a guest keeps the same user ID (turn on Supabase's "manual linking" and anonymous sign-ins, with CAPTCHA protection). If the email already has an account, the guest's data moves over.
- A personal profile is created automatically with a generated handle and becomes the active profile. Every request carries the active profile ID.
- **Done when:** tests prove guest → Apple upgrade keeps the same user and data, and sign out / sign in works on both phones.
- **How Elias checks it:** a hidden dev-menu button "Test save" opens the sheet; sign in with Apple, then see your profile.

### Phase 1 gate

- [ ] CI green
- [ ] Staging backend live
- [ ] Photo upload works end to end
- [ ] App on both phones with login
- [ ] PROGRESS.md up to date

**Not in this phase:** feeds, looks, AI, web pages.

## Phase 2 — The Pinterest feel

**Goal:** the app *feels* like Pinterest with real-looking content. That means an instant grid, a beautiful look page, effortless saving, boards, a taste picker and search (swipe mode moved to Phase 6). Shopping data comes in Phase 3, so the look page shows placeholders for products.

**Target:** weeks 3–4.

**You provide:** 300 outfit photos for the dev seed. Use your own, creators', or brands' photos with permission; they become launch content later.

### Step 2.1 — Looks in the database + seed loader

- Migration for `looks`, `look_media`, `follows`, `saves`, `boards`, `board_items`, `swipes`, `seen`, `events` (split by month) and `taste_profiles`, as in the data model.
- Seed command `pnpm seed:looks ./seed-folder`: reads photos + a `looks.json` (caption, tags, author handle), runs them through the photo pipeline, and creates published looks. Running it twice creates no duplicates.
- Also generate 10,000 fake looks on staging, only to test speed.
- **Done when:** 300 real looks are in dev and 10,000 test looks are on staging.

### Step 2.2 — The feed engine (rules, no AI yet)

- `GET /v1/feed/for-you` and `/v1/feed/following`, 20 looks per page with a cursor.
- Mix four pools:
  - fresh (last 72 hours)
  - popular (saves per view with time decay, recomputed every 15 minutes)
  - matches the taste picker (tags and brands)
  - from people you follow
- Diversity rules:
  - never the same author twice in a row
  - at most 2 similar looks in any 6
  - nothing seen in the last 7 days
- Each card returns photo sizes, width, height, thumbhash and item count.
- **Done when:**
  - tests prove no duplicates across pages
  - the diversity rules hold
  - the feed answers in under 300 ms (p95) on staging with 10,000 looks

### Step 2.3 — The home grid

- Two-column masonry grid. Cards show only the photo, a save button and the item count.
- Blurred previews until the photo loads, so the grid never jumps.
- At 60% scroll, fetch the next page and preload the photos for the next two screens.
- Pull to refresh, and a For You / Following switch at the top.
- On cold start, show the last feed stored on the phone instantly, then refresh.
- Log an impression when a card is at least half visible for 1 second, with its position, sent in batches.
- **Done when:** fast scrolling through 200 looks on a mid-range Android phone shows no blank cards or stutter, and a Maestro test scrolls and opens a look.
- **How Elias checks it:** scroll as fast as you can. It should feel like Pinterest.

### Step 2.4 — Saving, boards and the sign-up moment

- One-tap save with a small vibration and animation; double-tap a photo also saves.
- Press and hold a card for a quick menu: save to board, see less like this, share (wired in Phase 5).
- The first save creates the guest session, opens the sign-up sheet, and keeps that save after sign-up.
- Saves work offline and sync later; double taps never duplicate.
- **Saved** tab: all saves, plus boards (create, rename, delete). A look can be in several boards.
- **Done when:** a Maestro flow passes (save as guest → sign up → save still there), and saves made in airplane mode appear after reconnecting.

### Step 2.5 — The look page

- Tap a card and the photo grows smoothly into the look page.
- Swipeable photos, author row with follow button, caption.
- A placeholder area for the product list and garment dots (filled in Phase 3).
- Below: "more like this" using shared tags for now, upgraded to AI in Phase 3.
- Back returns to the exact scroll position.
- **Done when:** the look page opens in under 400 ms once the photo is cached, and the back button keeps your place.

### Step 2.6 — Taste picker

- At first open, swipe 8–10 looks, pick style chips (Minimal, Streetwear, Classic…) and favourite brands. It is skippable and takes under 30 seconds.
- Answers stay on the phone until there is an account, then save to `taste_profiles`. The feed uses them immediately.
- **Done when:** picking "Streetwear" makes most of the first page streetwear.

### Step 2.7 — Search and profiles

- Search tab with suggestion chips from popular tags, and results as a grid.
- Recent searches, and suggestions while typing in under 300 ms.
- Uses Postgres full-text search with typo tolerance.
- Profile screen: the user's looks, follower and following counts, follow button, and the Following feed working.
- **Done when:** searching "linnen" (a typo) still finds linen looks, and following someone fills the Following tab.

### Phase 2 gate

- [ ] You've scrolled, saved, built boards and searched on both phones
- [ ] You sign off that "it feels like Pinterest"
- [ ] Speed numbers recorded in PROGRESS.md

**Not in this phase:** products, prices, AI, posting.

## Phase 3 — Products and AI

**Goal:** every look becomes shoppable. The AI spots each garment, finds or checks the product, shows the price, and the Shop button opens the store inside the app. "More like this" and "similar pieces" become truly visual.

**Target:** weeks 5–6.

**You provide:**

- Gemini API key from Google AI Studio, with billing on
- 30 real product links from Nordic shops you want to support (Zalando, H&M, Boozt, NA-KD, Nelly, ASOS…)
- the seed looks' product links where you know them

### Step 3.1 — Product tables

- Migration for `garments`, `products`, `offers`, `look_items`, `link_checks` and `clicks`.
- Vector columns sized to the fashion model's output (read it from the model card, don't guess) with fast similarity indexes (HNSW).
- **Done when:** migrations pass and a test inserts and searches a vector.

### Step 3.2 — The fingerprint service

- Python FastAPI app in `services/embedder` running Marqo-FashionSigLIP on CPU.
- `POST /embed-image` takes an image link and an optional crop box. `POST /embed-text` takes words like "beige trench".
- Protected by a shared secret, deployed to Fly.io Stockholm, and set to sleep when idle to save money.
- **Done when:** one photo is fingerprinted in under 1.5 seconds once awake, tests pass, and the monthly cost estimate is written in PROGRESS.md.

### Step 3.3 — Garment spotting

- When a look's photo is ready, a job sends it to Gemini Flash-Lite with a strict JSON format:
  - each garment's category (from a fixed list in `packages/shared`), colour, pattern, material, visible brand text and position box
  - a one-sentence description and search tags
  - safety flags (nudity, violence, spam text)
- Each garment is cropped and fingerprinted, and the whole photo gets a fingerprint too.
- Store the model name, prompt version and cost of every call.
- A daily spend cap stops jobs if costs spike. Flagged photos are hidden and queued for review.
- **Done when:** on 50 hand-checked photos, at least 90% of clearly visible garments are found with correct boxes, and cost per 1,000 photos is measured and logged.
- **How Elias checks it:** a dev screen draws the boxes on photos.

### Step 3.4 — Paste a link, get a product

- `POST /v1/links/resolve`:
  - follows redirects and keeps the poster's affiliate tags
  - reads the shop's product data (schema.org JSON-LD, then Open Graph tags) for name, brand, price, currency, stock, image and barcode
  - creates or updates the product and offer, and fingerprints the product image
- A paid page reader (Microlink) is only a fallback behind a feature flag.
- Security: block requests to private network addresses (SSRF), with strict timeouts and size limits.
- **Done when:** at least 80% of your 30 test links resolve correctly, and the success rate is recorded.

### Step 3.5 — Automatic link check

- Compare the garment's fingerprint with the product photo's fingerprint:
  - high score → verified
  - middle → Gemini answers "same item? yes / no / unsure", and unsure goes to review
  - low, or sold out → rejected, with a plain message to the poster
- Thresholds live in settings, not code. Every check is saved in `link_checks`.
- **Done when:** on 100 labelled pairs, fewer than 5% of wrong items are auto-verified, and the numbers are recorded.

### Step 3.6 — The shoppable look page

- Tappable dots on each garment (from the AI boxes) jump to the item.
- Item list: product photo, brand, name, price, stock, "price checked today".
- "Total look €392". Tick the pieces you want for a running total.
- Board totals now show real value.
- **Done when:** the seed looks show real items with prices, and the totals add up correctly in tests.

### Step 3.7 — Shop clicks

- Tapping Shop logs a click: random click ID, look, offer, creator, feed position, screen.
- The store opens in the in-app browser (Safari sheet on iPhone, Chrome tab on Android), never the retailer's own app.
- Clicks made offline are queued.
- **Done when:** every tap creates exactly one click row (tested), and the store opens and returns to the same place in Outfitly.

### Step 3.8 — "More like this" and "similar pieces"

- Under every look: an endless feed of visually nearest looks. Only published looks, nothing recently seen, diversity rules applied.
- Tap a garment: the nearest products in the same category, with a "cheaper" sort.
- Search upgrade: words are fingerprinted too, so "beige trench" finds beige trenches even without that caption.
- **Done when:** both answer in under 300 ms (p95), and you rate the results on 20 looks as good.

### Step 3.9 — Price and stock refresh

- A daily job re-checks offers that are saved or in popular looks, with a daily cap; everything else weekly.
- Sold-out items turn grey. Every price change is kept as history for later price-drop alerts.
- **Done when:** a test product marked sold out turns grey after the next run.

### Phase 3 gate

- [ ] Every seed look has AI garments
- [ ] At least 70% of seed items have verified products
- [ ] Shop opens in-app
- [ ] "More like this" feels right
- [ ] AI cost per 1,000 photos is logged

**Not in this phase:** user posting, brands, web pages.

## Phase 4 — Accounts, creator upload and Google pages (V1)

**Goal:** the last piece of Version 1. Anyone can post a tagged look in under a minute. Accounts work like Instagram (personal, creator or business/brand, switchable in a tap), and every look, creator and brand has a fast web page Google can find.

**Target:** weeks 7–9.

**You provide:**

- 5 test creators and 2 test brands
- Google Search Console access for the domain

### Step 4.1 — Account types and switching (Instagram-style)

Three account types share one login system. The database was built for this in Phase 1 (`profiles` + `profile_members`).

| Type | Who | Extra tools |
| --- | --- | --- |
| **Personal** | Everyone, by default | Browse, save, boards, post looks |
| **Creator** | Anyone who wants to grow | A category label ("Stylist", "Fashion creator"), stats on every look, a link-in-bio page |
| **Business / brand** | Shops and brands | Brand name, logo, website, a **Products** tab, stats, and a brand page listing every look that contains its products |

- **Switch type anytime:** Settings → Account type, the way Instagram's "switch to professional account" works. Looks, followers and saves are kept when switching, and you can switch back.
- **Several profiles under one login:** a person can run a personal profile and a brand profile from one login. Hold the Profile tab to switch, exactly like Instagram. Up to 5 profiles per login.
- **Every action is done "as" the active profile,** including posts, saves, follows and clicks. Each profile has its own feed, saves and stats.
- **Done when:**
  - a Maestro test switches personal → creator → business → personal with nothing lost
  - one login holding a personal and a brand profile switches between them in under a second
  - tests prove one profile can never see another's private saves

### Step 4.2 — Create a look

1. Any account type can post from the Create tab. Pick up to 10 photos; they are shrunk on the phone and uploaded with a progress bar.
2. The AI's finds appear as cards ("We found 3 items"). For each one, confirm, swap, remove, paste your own link, or type it in (brand, name, price, link).
3. Dots can be dragged into place.
4. Add a caption plus occasion and season chips. The "contains affiliate links" label switches on by itself when a link has an affiliate tag.
5. Business accounts can also pick products from their own Products tab.
6. Looks can be saved as drafts, edited after publishing, or deleted. A published look stays "pending" until the link check passes, then goes live.

**Done when:** a Maestro test posts a 3-item look, and you can post one in under 60 seconds.

### Step 4.3 — Products tab for business accounts

- A business profile can add products: paste a product link (uses Step 3.4) or upload a simple CSV of name, price, link and image.
- Its products appear on its brand page and can be tagged in any look.
- **Done when:** a test brand adds 20 products from a CSV, and they appear tagged in looks.

### Step 4.4 — Stats for creator and business accounts

- Per look, over 7 and 30 days: views, opens, saves, shop clicks. Totals per profile: followers, profile visits, link-in-bio visits.
- Business accounts also get clicks per product.
- Numbers come from daily summary tables, never slow live counts. Personal accounts see none of this (as on Instagram).
- **Done when:** the stats match the raw events in tests.

### Step 4.5 — Safety basics and a mini review page

- In the app:
  - report a look or user
  - block a user, which hides their content both ways
  - "Wrong item?" on every tagged piece, where three reports hide the tag
  - rate limits on posting and pasting links
- A small admin page at `/admin` (admin accounts only) where you approve or reject:
  - AI-flagged photos
  - reports
  - unsure link checks
  - new accounts' first 3 posts
- This is the minimum Apple and Google need for an app where users post. The full admin comes in Phase 7.
- **Done when:** Maestro tests cover report, block and wrong-item, and you can clear the queue yourself.

### Step 4.6 — Google pages

- Server-rendered Next.js pages that work with JavaScript turned off:
  - `/l/[slug]` look
  - `/@[handle]` creator or personal profile
  - `/brand/[handle]` business profile
  - `/b/[id]` public board
- Each page has:
  - a real title and description written from the AI description
  - the product list with prices and working Shop buttons
  - schema.org structured data, a canonical address and a share image
  - the app banner on iPhone and an "Open in app" button
- After a few looks, a "Get the app to see more" prompt appears.
- Also `sitemap.xml` and `robots.txt`. Pages are cached at Cloudflare and refreshed when a look changes.
- **Done when:** Lighthouse SEO is 95+ on every page type, pages are fast on mobile, and the sitemap is submitted in Search Console.

### Step 4.7 — Link-in-bio for creators and brands

- `outfitly.com/@name` and `/brand/name` work as a link-in-bio: the profile's looks with Shop buttons. Web shop clicks are logged with source "web".
- A "Copy my link" button in the app, plus a short guide for creators.
- **Done when:** a test creator's link works from an Instagram bio on both phones.

### Phase 4 gate

- [ ] Posting takes under 60 seconds
- [ ] Switching between personal, creator and business works
- [ ] Every look, profile and brand has a Google-ready page
- [ ] 300+ real, shoppable looks are in the app

## Phase 5 — V1 launch

**Goal:** Version 1 goes live in both stores around mid-January 2027, after a one-week tester run. This phase holds everything legal and store-related, as agreed.

**Target:** weeks 10–11.

**You provide:**

- paid Supabase Pro
- 20–50 testers
- the lawyer's half-day review
- store listing copy and screenshots
- PostHog EU account
- your creators' launch content plan

### Step 5.1 — Production setup

- Separate production Supabase (Stockholm), Fly.io apps, R2 buckets and keys.
- Daily backups on. Database changes reach production only through CI with your approval.
- Sentry release tracking. EAS update channels for preview and production.
- `docs/RUNBOOK.md` covers deploy, roll back and restore.
- **Done when:** a full deploy to production works and a backup restore has been tested once.

### Step 5.2 — Metrics

- Final event list in `packages/shared`: impression (with position), open, save, unsave, board\_add, shop\_click, signup, post, search, profile\_switch, account\_type\_change.
- A small dashboard in `/admin`:
  - weekly savers
  - first-session save rate
  - day 1/7/30 return rates
  - looks posted
  - shop clicks
- PostHog EU receives key events only, after consent.
- **Done when:** the dashboard numbers match the raw events.

### Step 5.3 — Speed and polish pass

- Speed budgets on a mid-range Android and an older iPhone:
  - cached feed in under 2 seconds from a cold start
  - look page in under 400 ms
  - feed under 300 ms (p95)
  - almost no scroll stutter
- Designed empty, error and offline screens.
- Large-text and screen-reader check; final icon and splash.
- **DECISION:** dark or light by default.
- **DECISION:** English only, or + Swedish.
- **Done when:** the budgets are met (or the reasons recorded) and every screen is checked in both themes.

### Step 5.4 — One-week tester run

- TestFlight and Google Play closed testing with 20–50 people, plus in-app "Send feedback".
- Fix crashes and blockers only; everything else goes on the expansion list.
- **Done when:** a week with no crash-level bugs open.

### Step 5.5 — Legal and consent

- Privacy policy and terms, including content rules and a copyright takedown address.
- An analytics consent screen where "No" is as easy as "Yes".
- Account and profile deletion, and data download, inside the app.
- Every removal sends the poster a short reason (EU Digital Services Act).
- "Contains affiliate links" and "Reklam" labels checked against Swedish guidance.
- **DECISION:** 18+ only, or teens with stricter defaults.
- **DECISION:** whether the per-click ID needs Apple's tracking prompt.
- **Done when:** the lawyer signs off and every legal screen is in the app.

### Step 5.6 — Store submission

- **Apple:**
  - company account (D-U-N-S) and EU trader details
  - privacy labels and Sign in with Apple
  - review notes with a demo account, explaining report, block and moderation
  - phased release
- **Google:** Data safety, content rating, user-generated-content declarations.
- Submit at the start of week 11, leaving room for a rejection.
- **Done when:** both stores approve.

### Step 5.7 — Launch day

- Launch switches: sign-up open to all; open posting on.
- Check that the hooks for later money are recording: impressions with position, shop clicks, the sponsored flag on looks.
- Day-one cover:
  - Sentry alerts to your phone
  - Fly.io at least 2 machines
  - database size bumped up for launch week
  - someone on the review queue
- The creators' content push goes live the same morning. Review metrics on day 1 and day 7.
- **Done when:** the launch checklist in `docs/RUNBOOK.md` is fully ticked.

### V1 launch gate

- [ ] 1,000+ shoppable looks (aim for 2,000)
- [ ] Testers came back during the test week
- [ ] Both stores approved
- [ ] Lawyer signed off
- [ ] Speed and cost budgets met

## After V1: expansion phases

Once V1 is live, build in two-week phases, in the order real users' numbers point to. The default order is below. Every step uses the same session ritual and "Done when" discipline. Claude Code writes the detailed checklist for each step in plan mode, and you approve it before building.

### Phase 6 — Bring people back

- **6.1 Push notifications.** Ask permission right after the first save, with a friendly pre-screen first.
  - Types, each with a cap: "Your look was saved" at 1/10/25/100; "New look from @name", at most once a day; a weekly "New looks for your style" on Sunday evening.
  - Quiet hours, per-type settings, and every notification opens the right screen.
- **6.2 Swipe mode.** A full-screen deck from Home: right saves, left skips, up opens the look, a 3-second Undo, the next 3 photos preloaded, and a "Check price" sheet. Every swipe is logged.
- **6.3 Price-drop and back-in-stock alerts** on saved items, using the price history from Step 3.9.

### Phase 7 — Creators and brands, pro level

- **7.1 Deeper analytics:**
  - top looks
  - comparison with the previous period
  - follower growth
  - where views came from (feed, search, Google, link-in-bio)
  - for brands, the looks that drive clicks to each product
- **7.2 Bulk import.** Up to 50 past photos become AI-tagged drafts, confirmed with one tap each. This is the content-seeding engine.
- **7.3 Brand teams.** Several logins manage one business profile with roles (owner, editor). It builds on `profile_members`.
- **7.4 Shopify catalogue sync** for business accounts, plus verified badges.
- **7.5 Full admin:** feature/hide looks, creator and brand verification, curated categories (Summer, Wedding guest…) shown as tiles in Search, feature flags.

### Phase 8 — Growth loops

- **8.1 Links that open the app.** Apple's `apple-app-site-association` and Android's `assetlinks.json`, so shared links open the right screen.
- **8.2 Share out.** A branded Story image (1080 × 1920) for a look, board or profile, with a short link. Each share is credited to the sharer.
- **8.3 "Save to Outfitly".** The share-menu extension (check Expo compatibility first) and "Upload a screenshot": a private find of similar products. Social-post links ask for a screenshot instead.
- **8.4 Invites and referrals.** Invite codes and an "invited by" count.

### Phase 9 — Money

1. **Network commissions** on links that carry no creator tag (Awin, Adtraction, then a link converter).
2. **Boosted looks and brand subscriptions,** using the `is_sponsored` flag and the business accounts.
3. **Feed ads.**
4. **In-app checkout:** Shopify Checkout Kit first, then your own basket on Stripe Connect.
5. **Live shopping drops.**

The build review covers the order and reasoning.

## The GitHub repo

[eliascroesus/fashion](https://github.com/eliascroesus/fashion) is set up so Claude Code can start building immediately. It contains no app code yet; Step 1.1 creates it.

| File in the repo | What it does |
| --- | --- |
| `CLAUDE.md` | Rules and locked stack. Claude Code reads it automatically every session |
| `docs/BUILD_PLAN.md` | This document, as Markdown |
| `docs/PROGRESS.md` | Current step, decisions, open questions for you, measured numbers |
| `.claude/commands/start-step.md`, `stuck.md`, `status.md` | The `/start-step`, `/stuck` and `/status` shortcuts |
| `.claude/agents/step-reviewer.md` | The reviewer that checks every step against its "Done when" list |
| `.github/pull_request_template.md` | Every pull request shows the checklist results and how you test it |
| `README.md`, `.gitignore` | How to work in the repo; keeps secret files out of GitHub |

**When this document changes,** ask Claude Code: "Replace docs/BUILD\_PLAN.md with this updated plan" and paste the Markdown export. The doc and the repo then stay in step.

**To begin:** open Claude Code on the repo, type `/status`, then `/start-step 1.1`.
