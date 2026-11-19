# Trailhead

A two-person half-marathon training tracker (Beatrix and Julian). A 30-week plan, an activity feed with photos and
kudos, weekly fulfilment per person, head-to-head scoring, notes, and notifications when the other person logs something.

## Features

- **Plan overview**: 30 week tiles per person (fulfilled / current / missed / upcoming, % of planned km). Tap a week to see the
  planned runs, edit the km goal, and see what was logged into it. Each person has their own plan settings (Settings, My plan).
- **Flexible plan** (optional, per person): follow your progress instead of the calendar, see below.
- **Log activity**: run, hike, cycle, swim, strength, workout, with date, distance or time, note and photo. Live points and pace preview.
  Points = km x run-type multiplier (easy 1, long 1.3, tempo 1.6, speed 1.8, shakeout 1, race 3); hike 0.5/km; cycle 0.4, swim 0.6,
  strength 0.5, workout 0.6 per 30 min.
- **Feed** (Strava style cards, lazy-loaded photos, kudos), **Stats** (totals, longest run, best pace, streak, 8-week chart), **Notes** (message board with photos).
- **Notifications**: in-app toast + bell with unread count, and real Web Push to a closed phone (Cloudflare Worker, see below).
- Google sign-in restricted to two accounts; installable PWA.

## Stack

Vue 3 + Vite (SPA, no router: tabs sync with `#/feed|plan|stats|notes`), Firebase Auth (Google) and Realtime Database (modular SDK, lazy-loaded),
a Cloudflare Worker in `worker/` for Web Push, hosting as a Cloudflare Worker with static assets. Pure logic (`src/plan.js`, `scoring.js`,
`migration.js`, `notifications.js`, `viewmodels.js`, `push.js`, `identity.js`) has no Vue or Firebase dependency and is tested with `node --test`.

```
src/            app (store.js = state + actions, backend.js = Firebase / local adapter, components/*.vue)
css/            design system (tokens, base, components) + view styles; docs/DESIGN_SYSTEM.md, design-system.html
public/         sw.js, manifest.webmanifest, icons, _headers (copied to dist/ as-is)
worker/         Web Push Worker (own package.json, README.md, tests)
tests/          node:test unit tests for the app logic
database.rules.template.json  firebase.json  .firebaserc  wrangler.jsonc
```

## Local development

```sh
npm i
npm run dev          # http://localhost:5173
```

Open `http://localhost:5173/?local=1` for the **local demo mode**: no Firebase, no network, data in `localStorage`, and the sign-in screen
offers "Sign in as Beatrix / Julian" buttons. The console helper `window.__trailheadDebug` (local mode only) offers
`signInAs('a'|'b'|'other')`, `fakeEventFromOther()` (simulate the other person logging a run) and `backend`.
Without `?local=1` the app talks to the real Firebase project.

Commands: `npm run dev`, `npm run build` (-> `dist/`), `npm run preview`, `npm test`, `npm run deploy`.
The living style guide is `/design-system.html` (served by the dev server and copied to `dist/` by `vite.config.js`).

## Environment variables

Copy `.env.example` to `.env.local` (git-ignored). Vite reads it at build time, so build on the machine that has it. All values are optional;
the Firebase defaults in `src/firebaseConfig.js` point at the project `trailhead-hellner-tracker`. None of them are secrets (the Firebase web
config and the VAPID **public** key are public by design; access is enforced by Auth + database rules).

| Variable | Meaning |
|---|---|
| `VITE_FIREBASE_*` | override the Firebase web config (API key, auth domain, database URL, project id, bucket, sender id, app id) |
| `VITE_PERSON_A_EMAIL`, `VITE_PERSON_B_EMAIL` | the two allowed Google accounts (lowercase). Person A = gold, person B = olive |
| `VITE_DB_ROOT`, `VITE_MESSAGES_ROOT` | database roots, default `trailhead-tracker-v1` and `trailhead-tracker-v1-messages` |
| `VITE_VAPID_PUBLIC_KEY` | Web Push public key (output of `worker/scripts/gen-vapid.mjs`) |
| `VITE_PUSH_URL` | base URL of the deployed push Worker, no trailing path. Empty = no system push, in-app toasts still work |

## Firebase setup

1. Create a Firebase project, add a **Web app**, create a **Realtime Database**.
2. Authentication -> Sign-in method -> enable **Google**. Authentication -> Settings -> **Authorized domains**: add your hosting domain
   (`trailhead-tracker.<your-subdomain>.workers.dev` or your custom domain). `localhost` is there by default.
3. Put the two Google emails into `.env.local` (`VITE_PERSON_A_EMAIL`, `VITE_PERSON_B_EMAIL`). They are not committed: the repo only holds
   `database.rules.template.json`; `npm run rules:render` fills in the emails and writes the gitignored `database.rules.json`.
   Rules admit only these verified accounts.
4. Deploy the rules: `npx firebase-tools login` once, then `npm run deploy:rules` (renders the rules, then deploys `--only database`; project from `.firebaserc`).
   Firebase is used for data and login only; the app itself is hosted on Cloudflare.

## Cloudflare

**Push Worker** (`worker/`, details in `worker/README.md`):

```sh
cd worker && npm i
node scripts/gen-vapid.mjs                  # prints the VAPID public and private key (nothing is saved)
# put the public key into worker/wrangler.toml [vars] VAPID_PUBLIC_KEY and into .env.local VITE_VAPID_PUBLIC_KEY
npx wrangler login
# secrets never go into a file: VAPID_PRIVATE_KEY, PERSON_A_EMAIL, PERSON_B_EMAIL, VAPID_SUBJECT (mailto:...)
npx wrangler secret put VAPID_PRIVATE_KEY --config wrangler.toml   # paste the value; repeat for the other three
npx wrangler deploy --config wrangler.toml  # prints https://trailhead-push.<account>.workers.dev -> VITE_PUSH_URL
```

Pass `--config wrangler.toml` every time: the repo root also contains `wrangler.jsonc` (the app-hosting Worker) and wrangler can pick
that one up instead, which puts secrets on the wrong Worker.

Set `ALLOWED_ORIGINS` in `worker/wrangler.toml` to the exact origin of the hosted app (`https://trailhead-tracker.<account>.workers.dev`,
the Worker name comes from `wrangler.jsonc`); the CORS check blocks every other browser origin.

**App hosting** (root `wrangler.jsonc`: Worker `trailhead-tracker`, static assets from `dist/`, SPA fallback):

```sh
npm run deploy      # = npm run build && npx wrangler@4 deploy
```

## Data model

Realtime Database, everything below `trailhead-tracker-v1/` (full contract in `docs/REBUILD_PLAN.md` section 4):

```
nameA, nameB                 display names (legacy keys, still used)
goals/{runId}                plan-km overrides, e.g. "1-12-2-b": "9"
settings/{startDate, migratedV1}   startDate = legacy shared start, the fallback of both people
plans/{a|b}                  per-person plan state {mode?: 'calendar'|'rolling', startDate?, raceDate?, pauses?: [{from,to,note?}], skipped?: [sessionId],
                             repeatWeeks?: [planWeek], trainingDays?: [0-6], weeklyTarget?: 1-14}; absent node = fixed weeks, today's behaviour.
                             Each person writes only their own node (the app enforces it); the Worker only reads it.
log/{id}                     ActivityEntry {person, sport, runType?, title, date, km?, durationMin?, note?, week?, session?, hasPhoto, kudos?{a,b}, imported?, ts}
                             session = plan session the run is pinned to ('1-7-1-a', '...~r2' = repeat pass) or 'free' (never counts for a session)
photos/{id}                  data URL, compressed client side (<= ~400 KB); loaded lazily, removed with its entry
events/{id}                  {actor, kind: activity|kudos|week|note, text, refId?, ts}  -> toasts, bell, push
pushSubs/{a|b}/{hash}        Web Push subscriptions of that person's devices
trailhead-tracker-v1-messages/{key}   notes {sender, name, text, image, ts}
```

Week fulfilment: planned km = sum of the person's goals for the week, done km = their `run` entries mapped to the week
(`floor((date - startDate)/7) + 1`, or an explicit `week`). 100% = fulfilled; a finished week below 100% is missed.
The start date is the person's own `plans/<p>/startDate`, else `settings/startDate`, else the Monday of the first logged run's week. One-time migration (`settings/migratedV1`)
turns the old checkbox data (`checks`, `activities`) into log entries; legacy keys are never deleted.

## Flexible plan

By default everything works as it always did (**Fixed weeks**): plan week 1 starts on your start date, every week has its dates, and a
week you do not finish counts as missed. In Settings, **My plan** you can switch your own plan to **Flexible**:

- Progress follows your runs, not the calendar. Your next session is the first one you have not done yet; weeks are never "missed",
  you are only "behind by N sessions". A run counts for the earliest open session of its type; the log form shows
  "Counts for: Tempo, Week 7" and lets you pick another session or "Free run (no session)" (still earns points). Short runs (under 90%) count as partly done.
- **Pause** a date range (holiday, illness): paused days do not count as behind and do not break the week streak, and there is no reminder.
- **Skip** a session or **repeat** a week from the Plan tab (open a week). Both can be undone.
- Optional **race date**: weeks and sessions left, and a warning when the open sessions no longer fit before race day.
- **Training days**: reminders and Next up only suggest runs on those weekdays; the long run goes to the weekend training day.
- **Week streak** (both modes): consecutive Monday to Sunday weeks with at least your weekly target of runs (default 3, editable); paused weeks are skipped.
- You can switch back to Fixed weeks at any time, nothing you logged changes; the screen previews what changes before you confirm.
  Each person chooses for themselves, the other person's plan is read-only. Settings, skips, repeats and pauses are kept when switching.
  Training days, skips, repeats and pauses (except for the week streak) only take effect in Flexible mode.

## How push works, and its limits

1. Person A logs something: the app writes an `events/<id>` entry and POSTs `{eventId}` plus A's Firebase ID token to the Worker.
2. The Worker verifies the token and the allowlist, reads the event with A's own token, and sends a Web Push (VAPID, aes128gcm) to B's stored subscriptions.
3. B's service worker (`public/sw.js`) shows the notification (not when the app is visibly open: the toast covers that).

Limits: iOS delivers web push only to the app installed to the Home Screen (iOS 16.4+); push is best effort (no delivery receipts, 1 h TTL);
the app does not cache for offline use (the service worker only handles push); Firebase Auth `signInWithRedirect` (fallback when popups are blocked,
e.g. iOS standalone) can fail on a hosting domain different from the Firebase `authDomain` in browsers that partition third-party storage; the popup flow is not affected.

## Tests

```sh
npm test                 # app logic, ~350 tests (node --test tests/), incl. the flexible plan engine and golden tests for fixed weeks
cd worker && npm test    # Worker: token verification, handler, Web Push crypto
```

## Design system

`docs/DESIGN_SYSTEM.md` (tokens, components, rules), `css/`, and the living style guide `design-system.html`. View CSS may only use tokens.
