# Trailhead

A two-person half-marathon training tracker (Beatrix and Julian). A 30-week plan, an activity feed with photos and
kudos, weekly fulfilment per person, head-to-head scoring, notes, and notifications when the other person logs something.

## Features

- **Plan overview**: 30 week tiles per person (fulfilled / current / missed / upcoming, % of planned km). Tap a week to see the
  planned runs, edit the km goal, and see what was logged into it. The start date is configurable.
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
settings/{startDate, migratedV1}
log/{id}                     ActivityEntry {person, sport, runType?, title, date, km?, durationMin?, note?, week?, hasPhoto, kudos?{a,b}, imported?, ts}
photos/{id}                  data URL, compressed client side (<= ~400 KB); loaded lazily, removed with its entry
events/{id}                  {actor, kind: activity|kudos|week|note, text, refId?, ts}  -> toasts, bell, push
pushSubs/{a|b}/{hash}        Web Push subscriptions of that person's devices
trailhead-tracker-v1-messages/{key}   notes {sender, name, text, image, ts}
```

Week fulfilment: planned km = sum of the person's goals for the week, done km = their `run` entries mapped to the week
(`floor((date - startDate)/7) + 1`, or an explicit `week`). 100% = fulfilled; a finished week below 100% is missed.
The start date is `settings/startDate`, else the Monday of the first logged run's week. One-time migration (`settings/migratedV1`)
turns the old checkbox data (`checks`, `activities`) into log entries; legacy keys are never deleted.

## How push works, and its limits

1. Person A logs something: the app writes an `events/<id>` entry and POSTs `{eventId}` plus A's Firebase ID token to the Worker.
2. The Worker verifies the token and the allowlist, reads the event with A's own token, and sends a Web Push (VAPID, aes128gcm) to B's stored subscriptions.
3. B's service worker (`public/sw.js`) shows the notification (not when the app is visibly open: the toast covers that).

Limits: iOS delivers web push only to the app installed to the Home Screen (iOS 16.4+); push is best effort (no delivery receipts, 1 h TTL);
the app does not cache for offline use (the service worker only handles push); Firebase Auth `signInWithRedirect` (fallback when popups are blocked,
e.g. iOS standalone) can fail on a hosting domain different from the Firebase `authDomain` in browsers that partition third-party storage; the popup flow is not affected.

## Tests

```sh
npm test                 # app logic, 78 tests (node --test tests/)
cd worker && npm test    # Worker: token verification, handler, Web Push crypto
```

## Design system

`docs/DESIGN_SYSTEM.md` (tokens, components, rules), `css/`, and the living style guide `design-system.html`. View CSS may only use tokens.
