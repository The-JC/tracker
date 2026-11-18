# trailhead-push — Web Push from a free Cloudflare Worker

Sends a push notification to the *other* person's browser/phone, even when the app is closed, without
Firebase Cloud Functions or the Blaze plan and without FCM: the Worker talks standard Web Push
(RFC 8030, VAPID RFC 8292, aes128gcm RFC 8291) directly to the browser vendor's push service.

## Architecture

```
person A's app --(1) write event to RTDB (as today)
person A's app --(2) POST /notify {eventId} + Firebase ID token --> Worker
Worker: verify ID token (RS256, Google certs, allowlist)         -> actor = a
Worker: GET events/<id> from RTDB with A's token                 -> actor must be a, ts < 5 min old
Worker: GET pushSubs/b from RTDB with A's token                  -> B's subscription(s)
Worker: encrypt + VAPID-sign, POST to each subscription endpoint -> push service -> B's service worker
Worker: 404/410 from push service -> DELETE that subscription
```

The notification text is never taken from the request: it is read from the event in the database, which
only a signed-in allowlisted user can write, and only events authored by the caller (`event.actor`) are accepted.

## Endpoints

| Method | Path | Notes |
|---|---|---|
| GET | `/health` | `{"ok":true,"scheduler":bool}`; `scheduler` is true when the `FIREBASE_SERVICE_ACCOUNT` secret parses (nothing sensitive) |
| POST | `/notify` | body `{"eventId":"<push key>"}`, header `Authorization: Bearer <Firebase ID token>`. Responds `{"sent":n,"removed":m}` (or `{"sent":0,"removed":0,"duplicate":true}`) |
| POST | `/notify` | **test mode**, same auth: body `{"test":"self"\|"other"}` instead of `eventId`. No event is read; sends a fixed test text to the caller's own (`self`) or the other person's (`other`) devices. Responds `{"sent":n,"removed":m,"target":"self"}`, or `{"sent":0,"removed":0,"target":"other","reason":"no-subscription"}` (200) when the recipient has no stored subscription |
| POST | `/notify` | **reminder test**, same auth and the same 10 s rate limit: body `{"test":"reminder"}`. Builds the caller's own recommendation (the in-app "Next up" logic, `src/recommendForPerson.js`, database read with the caller's ID token, `today` in the tz from `settings/reminders/<me>`, else Europe/Zurich) and pushes it to the caller's own devices now. Responds `{"sent":n,"removed":m,"target":"self","kind":"run"|"rest"|"done"|"ahead"|"not-started"}`; for every non-`run` kind it also has `"rest":true` (the message is then titled `Test: ...`); `"reason":"no-subscription"` (200, nothing sent) only when the caller has no stored subscription |
| OPTIONS | any | CORS preflight (204) for origins in `ALLOWED_ORIGINS` |

Errors are JSON `{"error":"..."}`: 400 bad body/eventId/test value/timestamp, 429 test sent less than 10 s ago (with `Retry-After` seconds), 401 bad token, 403 account not allowlisted /
event not yours / disallowed origin / DB denied, 404 event not found, 410 event older than 5 min, 5xx server.

### Test notifications

`{"test":"self"}` pushes `Trailhead — Test notification — push is working on this device 🎉` to the caller's devices;
`{"test":"other"}` pushes `<caller name> sent you a test notification` to the other person (name from `nameA`/`nameB` in the
database, read with the caller's token, falling back to Beatrix/Julian). Tag `trailhead-test`, url `/`. Subscriptions are read,
encrypted/sent and dead ones (404/410) deleted exactly as for events. Rate limit: one test per 10 s per actor, best-effort and
per isolate (in-memory Map, like the replay guard). The Settings sheet of the app has the two buttons.

## Configuration

| Name | Kind | Value |
|---|---|---|
| `PROJECT_ID` | var | `trailhead-hellner-tracker` (token `aud`, `iss`) |
| `DB_URL` | var | Realtime Database URL |
| `PERSON_A_EMAIL`, `PERSON_B_EMAIL` | **secret** | allowlisted Google accounts (lowercase). Secrets, so the addresses stay out of the repo |
| `ALLOWED_ORIGINS` | var | comma separated: exact origins and/or `https://*.pages.dev` (any subdomain, not the apex) |
| `VAPID_PUBLIC_KEY` | var | base64url uncompressed P-256 point (public by design) |
| `VAPID_SUBJECT` | **secret** | `mailto:...` contact for the push services |
| `VAPID_PRIVATE_KEY` | **secret** | base64url raw private scalar `d` (`wrangler secret put`) |
| `FIREBASE_SERVICE_ACCOUNT` | **secret** | contents of a Google service account JSON key file; only needed for the daily reminders (see below) |

For production tighten `ALLOWED_ORIGINS` to your exact Pages domain: `https://*.pages.dev` also admits other
people's Pages sites as browser origins (they still cannot get past the token check, so this is defence in depth).

## Daily run reminders (Cron Trigger)

`wrangler.toml` has `[triggers] crons = ["*/5 * * * *"]` (cron triggers are free). Every 5 minutes `scheduled()` reads
`settings` and, for each person `a`/`b` with `settings/reminders/<p> = { enabled, time: 'HH:MM', tz, lastSentDate, updatedTs }`:

1. Local date and time are taken in the person's `tz` with `Intl.DateTimeFormat` (DST safe; an invalid tz falls back to `Europe/Zurich`).
2. Due when `enabled`, local time >= `time`, less than 3 hours (`WINDOW_MINUTES`) after it, and `lastSentDate` is not the local today.
   A time inside a DST gap (e.g. 02:30 on 2026-03-29 in Zurich) fires at the first tick after the gap; a repeated hour fires once.
   The window ends at local midnight (a 23:30 reminder is only sent until 23:59).
3. No stored subscription: skipped silently, the day is not claimed (subscribing later in the window still works).
4. The recommendation is `recommendForPerson` (log, goals, `settings/startDate`, today), identical to the app's Next-up card. If its kind is not
   `run`, or the person already logged any activity dated today, nothing is sent but the day is still claimed.
5. Otherwise `lastSentDate = today` is written **before** sending (at-most-once: a failed push is never retried, a missed day is better than a duplicate),
   then `Today: <run>` with the recommendation's reason (<= 140 chars) is pushed (tag `trailhead-reminder`, url `/#/feed`). Dead subscriptions are deleted.

The claim is a read-then-PATCH, not a transaction; two overlapping invocations in the same 5-minute slot could in theory both send.
`scheduled()` never throws; it logs concise lines (`reminder a: sent=1 removed=0`) visible in `wrangler tail`.

The cron has no signed-in user and so no Firebase ID token. It authenticates as a **Google service account** (OAuth2 JWT-bearer flow with WebCrypto,
RS256, scope `firebase.database` + `userinfo.email`; the access token is cached in isolate memory until ~60 s before expiry and sent as `Authorization: Bearer`).
Without the secret the cron logs `reminders disabled: no service account` once and does nothing; `GET /health` shows `"scheduler": false`.

Create the key: Firebase console -> Project settings -> Service accounts -> **Generate new private key** (downloads a JSON file). Then:

```sh
cd worker
npx wrangler secret put FIREBASE_SERVICE_ACCOUNT --config wrangler.toml --name trailhead-push < key.json
rm key.json            # delete the downloaded file (also from Downloads / the trash)
npx wrangler deploy --config wrangler.toml
curl https://trailhead-push.<account>.workers.dev/health   # {"ok":true,"scheduler":true}
```

Honest note: **a service account key bypasses the database security rules** (full admin access to the project). It must only ever live in the Worker
secret: never commit it, paste it into chat, or keep the JSON file around. If it leaks, delete the key in the Google Cloud console (IAM -> Service accounts -> Keys) and create a new one.
Real cron firing and the real Google OAuth exchange are covered by unit tests with fakes only; verify them once after deploying with the
"send test reminder" button (`{"test":"reminder"}`) and `npx wrangler tail --config wrangler.toml`.

## Deploy

```sh
cd worker && npm i
node scripts/gen-vapid.mjs          # prints VAPID_PUBLIC_KEY= and VAPID_PRIVATE_KEY= (stdout only, nothing saved)
# paste the public key into wrangler.toml [vars] VAPID_PUBLIC_KEY (and later into the client)
npx wrangler login                  # once
npx wrangler secret put VAPID_PRIVATE_KEY --config wrangler.toml   # paste the private key
npx wrangler secret put PERSON_A_EMAIL    --config wrangler.toml   # likewise PERSON_B_EMAIL, VAPID_SUBJECT (mailto:...)
npx wrangler deploy --config wrangler.toml   # prints https://trailhead-push.<account>.workers.dev
```

Always pass `--config wrangler.toml` (the `npm run deploy` script does): the repo root also has a `wrangler.jsonc` for the
app-hosting Worker, and wrangler can otherwise pick that one up and put secrets on the wrong Worker.

Keep the private key in your password manager. Rotating it invalidates all existing subscriptions
(users must re-subscribe with the new public key). Local dev: `npm run dev` (put secrets in `.dev.vars`,
which is git-ignored). Tests: `npm test` (node `--test`, no network).

## Client contract

1. Subscribe: `registration.pushManager.subscribe({ userVisibleOnly: true, applicationServerKey: VAPID_PUBLIC_KEY })`
   (needs notification permission, from a user gesture), then write `subscription.toJSON()` fields to
   `trailhead-tracker-v1/pushSubs/<me>/<endpointHash>` = `{ endpoint, keys: { p256dh, auth }, ts }`
   (any stable key, e.g. a hash of the endpoint, so a device re-subscribing overwrites itself). A single
   legacy object directly at `pushSubs/<me>` is also understood.
2. After writing an event, call the Worker (fire-and-forget; failures must not block the app):

```http
POST https://trailhead-push.<account>.workers.dev/notify
Authorization: Bearer <await auth.currentUser.getIdToken()>
Content-Type: application/json

{"eventId":"<the key the event was written under>"}
```

3. The service worker needs a `push` handler. The payload is JSON `{ "title", "body", "tag", "url" }`:
   `event.waitUntil(self.registration.showNotification(d.title, { body: d.body, tag: d.tag, data: { url: d.url } }))`.

Database rules: the existing `trailhead-tracker-v1` rule already lets both allowlisted users read and write everything
below it, so `pushSubs/*` needs no new rule (the Worker reads and deletes with the caller's own ID token).
If you later narrow the rules, `pushSubs/<person>` must stay writable by that person and readable/deletable by the other.

## Implementation notes

* **Own WebCrypto code, no runtime dependencies** (`src/webpush.js`, `src/firebaseToken.js`, `src/x509.js`, `src/serviceAccount.js`). The Worker bundle also imports the app's pure modules `../src/recommendForPerson.js`, `recommend.js`, `scoring.js`, `plan.js` so the reminder and the Next-up card share one pipeline.
  The crypto is ~60 lines, avoids supply-chain and Workers-compat issues, and is checked against an independent
  `node:crypto` receiver plus the RFC 8291 appendix A test vector. The x509 parser was also checked against Google's live certs.
* ID token: RS256 signature against Google's securetoken x509 certs (cached per `max-age`, forced refresh at most once a minute on
  unknown `kid`), `iss`, `aud`, `exp`, `iat`, `auth_time`, non-empty `sub`, `email_verified === true`, email allowlist.
* The Worker authenticates to the database *as the caller*, so the database rules remain the authority.

## Limitations (honest)

* **iOS/iPadOS** only delivers web push to a web app that was added to the Home Screen (iOS 16.4+) and opened from there once.
* Best-effort: push services may delay or drop messages (TTL is 1 h, urgency normal); there are no delivery receipts.
* Anti-replay is best-effort: events older than 5 min are rejected and an `eventId` is processed once **per isolate**
  (in-memory Map); a different isolate could re-send the same event within its 5 min window. Test notifications are limited to one per 10 s per actor, also per isolate; there is no other rate limiting.
* A recipient who never enabled notifications or has no stored subscription simply gets `sent: 0`.
* Free tier limits: Workers 100k requests/day, plenty for two users.
