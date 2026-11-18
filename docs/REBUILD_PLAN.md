# Trailhead tracker — Vue rebuild plan

## 1. What exists today (analysis)

| Area | Current state | Problem |
|---|---|---|
| Stack | Static `index.html` (2.8k lines, 30 weeks × 2 people hand-generated as HTML), `styles.css`, `app.js` (606 lines, vanilla DOM + Firebase compat SDK) | Plan data is baked into markup; state lives in the DOM (`collectData()` scrapes checkboxes); everything re-renders by `innerHTML` |
| Weeks | 30 collapsible tiles; each run is a checkbox + editable km goal; a week is "done" when all boxes are ticked | Ticking is detached from reality: no date, no proof, no way to log a run that differs from the plan |
| Scoring | points = km × type multiplier (Easy 1, Long 1.3, Tempo 1.6, Speed 1.8, Shakeout 1, Race 3); "Other activities": hiking 0.5/km, cycling 0.4 / 30 min, swimming 0.6, strength 0.5, workout 0.6 | Keep these rules exactly |
| Backend | Firebase Auth (one shared email, password gate) — replaced by Google sign-in, see §3, Realtime DB root `trailhead-tracker-v1` (`nameA`, `nameB`, `checks{id:bool}`, `goals{id:str}`, `activities{a:[],b:[]}`), messages at `trailhead-tracker-v1-messages` (text + data-URL photo) | No identity: the "sender" is a per-form toggle; nothing tells the other person what happened |
| Design | Burgundy `#4a1420` background, cream text, gold `#eeb81c` (person A), olive `#bcae32` (person B), Bricolage Grotesque + Inter, 14–24px radii, soft shadows | Colours/spacing are hard-coded in 366 lines of CSS, names like `--rust`/`--teal` don't match the actual colours |

Run IDs in the old plan are `1-<week>-<index>-<a|b>` (e.g. `1-29-2-b`). Goals overrides are keyed by the same id.

## 2. Goals (from the request)

1. **Weeks become an overview**, not a checklist: per week and per person show *fulfilled / in progress / missed / upcoming* and a **% of planned km**. Runs are entered through a **separate "Log activity" form** with **date + photo**.
2. **Notification when the other person completes something** (logs an activity; also kudos, a fulfilled week, a new note).
3. **Strava-inspired** UX: activity feed of cards with big stats (distance / time / pace / points), photo, **kudos**, weekly bar chart, streaks, personal records, bottom tab bar with a central "+" record button, head-to-head weekly comparison.
4. **Design system** derived from the current look, built first, by an agent.
5. Rebuild with **Vue 3**.

## 3. Key decisions

* **Vue 3 + Vite (build step, for performance).** Single-file components with `<script setup>`; `vue` and the **Firebase modular SDK** (tree-shaken) are npm dependencies split into `vendor-vue` / `vendor-firebase` chunks (`vite.config.js`, `base: '/'`: `dist/` is served from the root of its own origin as Cloudflare Worker static assets, see `wrangler.jsonc`). Heavy views (Plan, Stats, Notes, Settings) are lazy chunks. Pure logic (`plan`, `scoring`, `migration`, `notifications`) stays Vue-free and is tested with `node --test`. Commands: `npm run dev` (dev server), `npm run build` (→ `dist/`), `npm run preview`, `npm test`.
* **Firebase** (modular SDK; **Google sign-in** instead of the old shared password). Project config, the two allowed emails (`PEOPLE`) and database roots live in one file, `src/firebaseConfig.js`, overridable with `VITE_FIREBASE_*` / `VITE_PERSON_{A,B}_EMAIL` env vars (`.env.local`). The app now points at the new project `trailhead-hellner-tracker`, whose database starts empty (the legacy migration below then only sets its flag).
* **No data loss / no rules surprises.** New data is written as *new child keys under the existing root* `trailhead-tracker-v1/` (`log`, `photos`, `events`, `settings`). Legacy keys (`checks`, `goals`, `activities`, `nameA`, `nameB`) are never deleted. `goals` is still read **and written** in the old format. Messages stay at `trailhead-tracker-v1-messages`.
* **One-time migration** (idempotent, guarded by `settings/migratedV1`): every legacy checked run → a `log` entry `{sport:'run', runType, km: goal km, week: N, imported:true, date:null}`; every legacy "other activity" → a `log` entry with its sport/amount and old `ts`.
* **Identity = Google account.** `signInWithGoogle()` (Firebase Auth `signInWithPopup`, falling back to `signInWithRedirect` when popups are blocked, e.g. iOS standalone PWAs). The account email (lowercase) is matched against `PEOPLE.a/b.email` (`src/identity.js`) to derive `store.me`; any other account gets `authState = 'denied'` ("This Google account is not on the allowlist") and is signed out. Nobody chooses who they are, so there is no identity prompt and no per-form sender toggle. Security is enforced server-side too: `database.rules.json` only admits the two verified emails (replace the `__EMAIL_A__` / `__EMAIL_B__` placeholders before deploying the rules). Local dev (`?local=1`) offers a fake sign-in as person a or b.
* **Notifications**: realtime events feed in Firebase (`events/`). Each client listens, ignores its own events, shows an in-app toast + bell with unread badge, and (after the user taps "Enable alerts") a system notification via the service worker / Notification API. Push to a closed phone is done by the Cloudflare Worker in `worker/` (Web Push, VAPID; see `worker/README.md`), not by FCM or Cloud Functions; the stored subscriptions live at `pushSubs/<person>/<hash>`.
* **Plan start date** (`settings/startDate`) maps a logged date to a plan week: `week = floor((date − startDate)/7) + 1`. If unset, the effective start is the Monday of the earliest logged dated run's week (else the current week's Monday). Editable in Settings. An entry may carry an explicit `week` override (used by migration).
* **Photos** are compressed client-side (≤1000 px, JPEG, ≤~400 KB data URL) and stored at `photos/<id>`, **not** inside the `log` entry, so the feed loads fast; cards lazy-load their photo.

## 4. Data model (contract)

```
trailhead-tracker-v1/
  nameA, nameB                      legacy, still read/written for names
  goals/{runId}: "5.5"              plan-km overrides (legacy format, kept)
  settings/{startDate, migratedV1}
  settings/reminders/{a|b}: { enabled, time:'HH:MM', tz, lastSentDate:'YYYY-MM-DD'|null, updatedTs }   daily run reminder (see below)
  log/{id}: ActivityEntry
  photos/{id}: "data:image/jpeg;base64,…"
  events/{id}: EventEntry
  pushSubs/{a|b}/{endpointHash}: { endpoint, keys:{p256dh,auth}, ts }   Web Push subscriptions (read by the Worker)
trailhead-tracker-v1-messages/{key}: {sender,name,text,image,ts}   (unchanged)
```

```ts
ActivityEntry = {
  id: string,                       // = push key
  person: 'a'|'b',
  sport: 'run'|'hike'|'cycle'|'swim'|'strength'|'workout',
  runType?: 'easy'|'long'|'tempo'|'speed'|'shakeout'|'race',   // run only, default 'easy'
  title: string,                    // defaults to "Morning run" style or "Week N · Easy" for imports
  date: 'YYYY-MM-DD'|null,          // local date the activity happened; null only for imports
  km?: number, durationMin?: number,
  note?: string,
  week?: number,                    // explicit plan-week override
  hasPhoto: boolean,
  kudos?: { a?: true, b?: true },
  imported?: true,
  ts: number,                       // creation time (ms)
  editedTs?: number                 // set by updateActivity on every edit (ms); the card shows an "edited" tag
}
EventEntry = { id, actor:'a'|'b', kind:'activity'|'kudos'|'week'|'note', text: string, refId?: string, ts: number }
```

Sports: `run` (needs km), `hike` (needs km, 0.5 pts/km), `cycle` (needs min, 0.4/30 min), `swim` (needs min, 0.6/30 min), `strength` (needs min, 0.5/30 min), `workout` (needs min, 0.6/30 min). Runs: points = km × run-type multiplier. All sports accept optional extra fields (`durationMin` for runs → pace).

**Daily run reminder** (`settings/reminders/<a|b>`): `enabled` boolean (default off), `time` 'HH:MM' 24 h in the person's own time zone (default '07:30', 5-minute steps), `tz` IANA zone of the device that last saved it (kept fresh on app start/sign-in/foreground while enabled, for travel), `lastSentDate` 'YYYY-MM-DD' (the person's local date of the last reminder; **written by the Cloudflare cron**, and by the client only to *today* when an enabled time is saved that has already passed today, so enabling at 21:00 for 20:00 does not fire at once), `updatedTs` ms. The client merges only `enabled/time/tz/updatedTs` (+ that one `lastSentDate` case), never `undefined` values, and each person edits only their own node. The cron sends today's recommended run (same as the Next-up card) to the person's `pushSubs`, only on days with a run and nothing logged yet. `POST /notify {"test":"reminder"}` sends a test of it.

**Week fulfilment** (per person, per plan week): planned km `P` = sum of that person's goals (override ?? default) for the week; done km `D` = sum of `km` of `sport:'run'` entries mapped to that week; `pct = P ? min(100, round(100·D/P)) : null`. Status: `fulfilled` (pct = 100), `missed` (week over, pct < 100), `current` (week contains today, pct < 100), `upcoming`. Races/weeks with `P = 0` → `n/a`.

## 5. File layout

```
index.html                    Vite entry: fonts, <div id="app">, <script type="module" src="/src/main.js">
package.json vite.config.js   scripts: dev / build / preview / test
public/                       sw.js, manifest.webmanifest, icon.svg (copied as-is to dist/)
css/tokens.css base.css components.css          ← design-system agent
css/views-feed.css css/views-plan.css           ← UI agents (tokens only, no raw hex/px scale violations)
design-system.html            living style guide
docs/DESIGN_SYSTEM.md, docs/REBUILD_PLAN.md
src/main.js                   imports CSS from ../css, createApp, mount, service worker
src/App.vue                   shell: header, tab views, bottom nav, toasts, auth gate
src/firebaseConfig.js         Firebase config + db roots (env-overridable)
src/backend.js                Firebase (modular, lazy) + in-memory/localStorage adapter (`?local=1`)
src/store.js                  reactive singleton + actions (below)
src/plan.js                   PLAN (30 weeks, extracted from the old HTML), RUN_TYPES, SPORTS
src/scoring.js                pure functions (points, pace, week mapping, week summaries, streaks, records, weekly series)
src/migration.js              pure legacy -> log entries
src/notifications.js          pure event/unread logic + browser notification helpers
src/utils/image.js            compressImage()
src/components/*.vue          see §6 (SFCs, <script setup>, design-system classes, no scoped styles)
tests/*.test.mjs              node --test for plan/scoring/migration/notification/backend logic
```

## 6. Store contract (UI agents code against this; core agent implements it exactly, may only add)

```js
// src/store.js
export const store = reactive({
  authState: 'loading'|'signedOut'|'signedIn'|'denied', authError: '',
  user: null|{ email, displayName, photoURL },   // signed-in Google account (also set while 'denied')
  me: 'a'|'b'|null,                 // derived from user.email via PEOPLE; never chosen manually
  names: { a:'Beatrix', b:'Julian' },
  settings: { startDate: null|'YYYY-MM-DD' },
  reminders: { a: Reminder, b: Reminder },   // Reminder = { enabled, time:'HH:MM', tz, lastSentDate:null|'YYYY-MM-DD', updatedTs } with defaults filled (src/utils/reminderTime.js normalizeReminder)
  goals: { [runId]: string },
  log: ActivityEntry[],            // newest first (date desc, then ts desc)
  events: EventEntry[],            // newest first
  lastReadTs: number,
  toasts: [{ id, text, kind }],
  notes: [{ key, sender, name, text, image, ts }],   // newest first
  notifPermission: 'default'|'granted'|'denied'|'unsupported',
  backend: 'firebase'|'local', online: boolean
})
export const effectiveStartDate  // computed ref → 'YYYY-MM-DD'
export const scoreboard          // computed → { a:{points,km,runKm,count,planPct,streak}, b:{…} }
export const weeks               // computed → [{ n, kind, tag, current, a:WeekPerson, b:WeekPerson }]
                                 //   WeekPerson = { plannedKm, doneKm, pct|null, status, runs:[{id,type,detail,km,mult}] }
export const stats               // computed → { a:Stats, b:Stats }  Stats = { totalKm, totalPoints, count, longestRunKm, bestPaceMinPerKm|null, streakDays, weeklyKm:[{weekStart,km}×8] }
export const unreadCount         // computed → events by the other person newer than lastReadTs

export function signInWithGoogle(localPerson?): Promise<void>;  export function signOut(): Promise<void>   // localPerson 'a'|'b' only used by the ?local=1 backend
export function setName(p, name), setStartDate(iso|null), setGoal(runId, kmString)
export function addActivity(input /* {sport,runType?,title?,date,km?,durationMin?,note?,photoDataUrl?} */): Promise<string>  // person = store.me; emits an 'activity' event, and a 'week' event when a week becomes fulfilled
export function updateActivity(id, patch /* addActivity input shape, plus removePhoto?: true; no photo key keeps the photo */): Promise<string>
  // own entries only; validates like addActivity (+ no future date); writes only changed fields + editedTs (never person/id/ts/kudos/imported);
  // writes/removes photos/<id> and keeps hasPhoto in sync; no event for a plain edit, but emits the 'week' event when the edit newly fulfils the week
export function deleteActivity(id): Promise<void>
export function toggleKudos(id): Promise<void>    // emits 'kudos' event when giving, to the owner
export function loadPhoto(id): Promise<string|null>   // cached
export function postNote({text, imageDataUrl}): Promise<void>; export function deleteNote(key): Promise<void>
export function markEventsRead(), dismissToast(id), enableSystemNotifications(): Promise<void>
export function setReminder({ enabled?, time? }): Promise<Reminder>
  // own settings/reminders/<me> only; time must be 'HH:MM' (00:00-23:59, else throws) and is rounded to 5 minutes; omitted fields keep their value;
  // stamps tz (device zone) + updatedTs, merges only those fields (never touches lastSentDate except: = today when an enabled time has already passed today);
  // optimistic, offline-safe (settle). The store also re-stamps tz silently on start/sign-in/foreground when the device zone changed and reminders are on.
export function sendTestNotification(target: 'self'|'other'|'reminder'): Promise<void>   // result in store.testPush; 'reminder' = Worker POST /notify {"test":"reminder"}
```

Components (one `.vue` SFC each, in `src/components/`; they read `store` directly, no prop plumbing needed unless stated):

| File | Owner | Purpose |
|---|---|---|
| `AuthGate.vue` `ToastHost.vue` `NotificationBell.vue` `SettingsSheet.vue` `Scoreboard.vue` `NotesView.vue` `PlanView.vue` `StatsView.vue` | UI-B | shell chrome, overview, stats, notifications UI |
| `LogActivitySheet.vue` `ActivityCard.vue` `FeedView.vue` | UI-A | the new "log" form + Strava-style feed |

`App.vue` (core agent) registers all of them and ships **stub versions** of every component so the app boots from the first commit; UI agents overwrite the stubs.

## 7. UX spec (Strava-inspired)

* **Header**: logo/kicker, notification bell (unread badge), avatar chip of "me" → Settings.
* **Scoreboard** (top of Feed): both people side by side — points, km, overall plan %, current streak; "this week" head-to-head bars.
* **Bottom tab bar**: Feed · Plan · ＋ (central round button, opens the Log sheet) · Stats · Notes. Desktop: same bar, centered max-width.
* **Log sheet** (bottom sheet on mobile): sport picker chips (run/hike/cycle/swim/strength/workout), run-type chips for runs, title, **date** (default today, native date input), distance or duration (per sport rules) + optional time → live pace + points preview, note, **photo** picker with preview, Save. Shows "Counts for Week N" chip.
* **Feed**: activity cards newest-first: coloured initial avatar + name, relative date, title, big stat row (km · time · pace · pts), photo, note, kudos button (👏 with count / who), delete (own entries). "Show more" pagination (20 at a time). Empty state. Imported legacy entries render compactly with an "imported" chip.
* **Plan** (overview, read-only status): headline "x of 30 weeks fulfilled" per person; grid of 30 week tiles each showing ring/percent per person, status colour, race week flag; tapping a tile expands the planned runs (type, detail, target km; km editable inline → `setGoal`) and the activities logged into that week. The current week is highlighted and scrolled into view. "Set plan start date" shortcut if unset.
* **Stats**: per person totals, longest run, best pace, streak, last-8-weeks km bar chart (both people, inline SVG, no chart lib), "Run types explained" collapsible (the old cards).
* **Notes**: the old message board (text + photo), restyled with the design system; now also emits `note` events.
* **Notifications**: toast "Julian logged a 8.2 km run 🏃", bell panel list with mark-all-read, "Enable alerts" button for system notifications; `document.title` shows "(2) Trailhead" while unread.
* Mobile-first, safe-area aware, `prefers-reduced-motion` respected, all interactive elements ≥ 44 px, visible focus rings.

## 8. Execution plan (agents)

| Phase | Agent | Task | Depends on |
|---|---|---|---|
| 0a | **Design system** | tokens + base + components css, `design-system.html`, `docs/DESIGN_SYSTEM.md` (derived from the current palette/type/radii; AA contrast verified) | — |
| 0b | **Core** | extract plan to `src/plan.js` **from `git show HEAD:index.html` before touching index.html**; `scoring.js`, `backend.js`, `store.js`, `notifications.js`, `App.vue` + stubs, Vite setup, `index.html`, `main.js`, `public/sw.js`, manifest; migration; node tests | — (parallel with 0a; disjoint files) |
| 1a | **UI-A** Feed & Log | `LogActivitySheet`, `ActivityCard`, `FeedView`, `utils/image.js`, `css/views-feed.css` | 0a, 0b |
| 1b | **UI-B** Plan, Stats, Chrome | remaining components + `css/views-plan.css` | 0a, 0b |
| 2 | **QA** | run tests, `node --check`, browser smoke test in `?local=1`, review contract adherence, fix, delete old `app.js`/`styles.css`, update README/docs | 1a, 1b |

No commit is made by agents; the result is left in the working tree for review.
