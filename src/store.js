// Reactive singleton store + actions: the contract UI components code against (docs/REBUILD_PLAN.md §6).
// All business logic lives in the pure modules (scoring/plan/migration/notifications); this file only
// wires them to Vue reactivity and the backend.
import { reactive, computed, ref, watch } from 'vue';
import { PLAN, PLAN_RUN_BY_ID } from './plan.js';
import {
  todayISO, isValidISODate, scoreboard as calcScoreboard, stats as calcStats, sortLog, validateActivityInput, sessionPinAllowed
} from './scoring.js';
import {
  normalizePlanState, validatePlanPatch, effectiveStartFor, buildWeeksFor, weekWindowsFor, weekStreak
} from './planModel.js';
import { raceDateError, pauseError } from './utils/planSettingsForm.js';
import {
  rollingStateFor, skipSessionPatch, unskipSessionPatch, repeatWeekPatch, unrepeatWeekPatch, addPausePatch, removePausePatch
} from './rolling.js';
import { migrateLegacy } from './migration.js';
import {
  activityEventText, weekEventText, kudosEventText, noteEventText, unreadEvents, freshEvents, nextLastRead,
  documentTitle, toastFor, shouldShowSystemNotification, currentPermission, requestPermission,
  showSystemNotification, loadLastRead, saveLastRead
} from './notifications.js';
import { createBackend, fakeEventFromOther } from './backend.js';
import { DB_ROOT, MESSAGES_ROOT, PEOPLE, PUSH_URL, VAPID_PUBLIC_KEY } from './firebaseConfig.js';
import {
  isPushSupported, currentSubscription, subscribeToPush, unsubscribeFromPush, endpointHash, subscriptionRecord, notifyWorker, sendTestPush, testPushMessage
} from './push.js';
import { resolveUser } from './identity.js';
import { settle } from './utils/settle.js';
import { prepareEdit, newlyFulfilledWeek, hasWeekEvent, weekFulfillment, rollingNewlyFulfilledWeek } from './utils/entryPatch.js';
import { normalizeReminder, isValidTime, roundTime, deviceTimeZone, isValidTimeZone, buildReminderPatch } from './utils/reminderTime.js';

const DEFAULT_NAMES = { a: PEOPLE.a.name, b: PEOPLE.b.name };
const P = {
  nameA: `${DB_ROOT}/nameA`, nameB: `${DB_ROOT}/nameB`, goals: `${DB_ROOT}/goals`, checks: `${DB_ROOT}/checks`,
  activities: `${DB_ROOT}/activities`, settings: `${DB_ROOT}/settings`, reminders: `${DB_ROOT}/settings/reminders`, plans: `${DB_ROOT}/plans`, log: `${DB_ROOT}/log`,
  photos: `${DB_ROOT}/photos`, events: `${DB_ROOT}/events`, pushSubs: `${DB_ROOT}/pushSubs`, messages: MESSAGES_ROOT
};
const TOAST_MS = 5000;

const validPerson = p => (p === 'a' || p === 'b' ? p : null);
const GOOGLE_CANCELLED = ['auth/popup-closed-by-user', 'auth/cancelled-popup-request', 'auth/user-cancelled'];

// Firebase rejects `undefined`; strip it (shallowly is enough for our flat entries, nested for kudos).
function clean(obj) {
  const out = {};
  for (const [k, v] of Object.entries(obj)) {
    if (v === undefined) continue;
    out[k] = v && typeof v === 'object' && !Array.isArray(v) ? clean(v) : v;
  }
  return out;
}

const lastRead = loadLastRead();
if (lastRead.firstRun) saveLastRead(lastRead.value);

export const store = reactive({
  authState: 'loading', // 'loading' | 'signedOut' | 'signedIn' | 'denied'
  authError: '',
  user: null,           // { email, displayName, photoURL } of the signed-in Google account
  me: null,             // 'a' | 'b', derived from the account's email (never chosen manually)
  names: { ...DEFAULT_NAMES },
  settings: { startDate: null },
  reminders: { a: normalizeReminder(), b: normalizeReminder() }, // settings/reminders/<a|b>: daily run reminder (the server writes lastSentDate)
  plans: normalizePlanState(), // plans/<a|b>: per-person plan state as stored (planModel.normalizePlanState); see planStates for the effective one
  goals: {},
  log: [],
  logLoaded: false,     // true after the first `log` snapshot (feed skeleton vs. empty state)
  syncError: '',        // set when a database read is refused/fails (shown as a banner), cleared by the next log snapshot
  events: [],
  lastReadTs: lastRead.value,
  toasts: [],
  notes: [],
  notifPermission: currentPermission(),
  pushActive: false,    // true while this device has a Web Push subscription stored for `me` (Firebase backend only)
  pushBusy: false,      // enabling/disabling/re-syncing in progress
  testPush: { busy: false, message: '', kind: 'success' }, // result of the Settings "Send test notification" buttons (kind: success | warning | error)
  backend: 'firebase',
  online: typeof navigator !== 'undefined' ? navigator.onLine !== false : true
});

/* ---------- derived state ---------- */

// "Today" as a ref so everything derived re-evaluates after midnight / when the app is reopened.
export const today = ref(todayISO());
const refreshToday = () => { today.value = todayISO(); };

// Per-person plan state with the legacy global settings/startDate filled in as each person's fallback start.
export const planStates = computed(() => normalizePlanState(store.plans, { settingsStartDate: store.settings.startDate }));
// Start of `person`'s plan (own plan start, else settings/startDate, else the automatic rule).
export const effectiveStartForPerson = person => effectiveStartFor(person, planStates.value, store.log, today.value);
// The signed-in person's start (kept for compatibility; person a's before sign-in).
export const effectiveStartDate = computed(() => effectiveStartForPerson(store.me || 'a'));
// Each person is evaluated against their own start; the top-level fields (current, startDate, endDate) follow the signed-in person.
export const weeks = computed(() => buildWeeksFor({ plan: PLAN, goals: store.goals, log: store.log, state: planStates.value, todayISO: today.value, viewer: store.me || 'a' }));
// { a: [{ n, startDate, endDate, current, over }], b: [...] }: the plan weeks' dates for each person's own start.
export const weekWindows = computed(() => weekWindowsFor({ plan: PLAN, log: store.log, state: planStates.value, todayISO: today.value }));
// { a, b } each { current, best, thisWeek: { runs, target, met, paused }, target } (planModel.weekStreak)
export const weekStreaks = computed(() => ({
  a: weekStreak({ log: store.log, person: 'a', state: planStates.value, plan: PLAN, goals: store.goals, todayISO: today.value }),
  b: weekStreak({ log: store.log, person: 'b', state: planStates.value, plan: PLAN, goals: store.goals, todayISO: today.value })
}));
// Flexible-plan view of each person who is in flexible mode: { a: { sessions, match, state, startDate } | null, b: ... }
// (rolling.rollingStateFor). The log form suggests sessions from it and the feed cards say which session a run counts for.
export const rollingViews = computed(() => Object.fromEntries(['a', 'b'].map(p => [p, planStates.value[p].mode === 'rolling'
  ? rollingStateFor({ plan: PLAN, goals: store.goals, log: store.log, person: p, state: planStates.value[p], startDate: effectiveStartForPerson(p), todayISO: today.value })
  : null])));
export const scoreboard = computed(() => calcScoreboard(store.log, weeks.value, today.value));
export const stats = computed(() => calcStats(store.log, today.value));
export const unreadCount = computed(() => unreadEvents(store.events, store.me, store.lastReadTs).length);

/* ---------- backend wiring ---------- */

let backend = null;
let started = null; // promise, so initStore() is idempotent
let unsubs = [];
let knownEventIds = null; // null until the first events snapshot (baseline, no toasts)
let migrationTried = false;
let remindersLoaded = false; // true after the first settings/reminders snapshot (defaults must never be mistaken for stored data)
const photoCache = new Map();

const asEntries = obj => Object.entries(obj || {}).map(([key, v]) => ({ ...v, id: v.id || key }));

function startSync() {
  stopSync();
  knownEventIds = null;
  migrationTried = false;
  const sub = (path, cb, opts) => unsubs.push(backend.subscribe(path, cb, {
    onError: e => {
      console.error('Read failed:', path, e);
      if (store.authState === 'signedIn') store.syncError = "Couldn't load the latest data. Check your connection, or that the database rules allow this account.";
    },
    ...opts
  }));
  sub(P.nameA, v => { store.names.a = v || DEFAULT_NAMES.a; });
  sub(P.nameB, v => { store.names.b = v || DEFAULT_NAMES.b; });
  sub(P.goals, v => { store.goals = v && typeof v === 'object' ? v : {}; });
  sub(P.settings, v => {
    const s = v || {};
    store.settings.startDate = s.startDate && isValidISODate(s.startDate) ? s.startDate : null;
    if (!s.migratedV1 && !migrationTried) { migrationTried = true; runMigration(); }
  });
  sub(P.plans, v => { store.plans = normalizePlanState(v); });
  sub(P.reminders, v => {
    const r = v && typeof v === 'object' ? v : {};
    store.reminders = { a: normalizeReminder(r.a), b: normalizeReminder(r.b) };
    remindersLoaded = true;
    syncReminderTz();
  });
  sub(P.log, v => { const next = sortLog(asEntries(v)); dropStalePhotos(store.log, next); store.log = next; store.logLoaded = true; store.syncError = ''; });
  sub(P.events, v => onEvents(asEntries(v)), { limitToLast: 50 });
  sub(P.messages, v => {
    store.notes = Object.entries(v || {})
      .map(([key, m]) => ({ key, sender: m.sender, name: m.name || '', text: m.text || '', image: m.image || null, ts: m.ts || 0 }))
      .sort((x, y) => y.ts - x.ts);
  }, { limitToLast: 30 });
  // `.info/connected` is false for a moment while the socket opens: only report "offline" after 3 s of it.
  let offlineTimer = null;
  unsubs.push(backend.onConnection(on => {
    clearTimeout(offlineTimer);
    if (on) store.online = true; else offlineTimer = setTimeout(() => { store.online = false; }, 3000);
  }));
  unsubs.push(() => clearTimeout(offlineTimer));
}

function stopSync() {
  unsubs.forEach(u => { try { u(); } catch (e) { /* ignore */ } });
  unsubs = [];
  store.log = []; store.logLoaded = false; store.syncError = ''; store.events = []; store.notes = []; store.goals = {};
  store.settings.startDate = null;
  store.plans = normalizePlanState();
  store.reminders = { a: normalizeReminder(), b: normalizeReminder() };
  remindersLoaded = false;
  knownEventIds = null;
  photoCache.clear();
}

// Runs once per database: whoever first sees `settings/migratedV1` unset claims it (transaction) and migrates.
async function runMigration() {
  const flag = `${P.settings}/migratedV1`;
  let claimed = false;
  try {
    claimed = await backend.claimOnce(flag, Date.now());
    if (!claimed) return;
    const [checks, goals, activities] = await Promise.all([backend.get(P.checks), backend.get(P.goals), backend.get(P.activities)]);
    const entries = migrateLegacy({ checks, goals, activities }, PLAN);
    if (entries.length) {
      await backend.update(P.log, Object.fromEntries(entries.map(e => [e.id, clean(e)])));
    }
    if (entries.length) pushToast(`Imported ${entries.length} earlier entries from the old tracker`, 'info');
  } catch (e) {
    console.error('Migration failed:', e);
    if (claimed) backend.remove(flag).catch(() => {}); // let the next client retry
  }
}

function onEvents(list) {
  list.sort((x, y) => (y.ts || 0) - (x.ts || 0) || (x.id < y.id ? 1 : -1)); // newest first
  const fresh = freshEvents(list, store.me, knownEventIds);
  knownEventIds = new Set(list.map(e => e.id));
  store.events = list;
  for (const e of fresh) {
    const { text, kind } = toastFor(e, store.log);
    pushToast(text, kind, e.actor);
    if (shouldShowSystemNotification({ permission: store.notifPermission, hidden: typeof document !== 'undefined' && document.hidden, pushActive: store.pushActive })) {
      showSystemNotification(e.text, { tag: e.id, icon: iconUrl() });
    }
  }
}

const iconUrl = () => ((import.meta.env && import.meta.env.BASE_URL) || './') + 'icon.svg';

/* ---------- init ---------- */

export function initStore() {
  if (started) return started;
  started = (async () => {
    const result = await createBackend();
    backend = result.backend;
    store.backend = backend.kind;
    if (result.error) store.authError = result.error;
    if (backend.kind === 'local' && typeof window !== 'undefined') {
      window.__trailheadDebug = {
        fakeEventFromOther: () => fakeEventFromOther(backend, store.me, store.names),
        signInAs: person => backend.signInWithGoogle(person), // 'a' | 'b' | 'other' (denied)
        backend
      };
    }
    backend.onAuth(handleAuth);
    if (typeof navigator !== 'undefined' && navigator.serviceWorker) {
      // The service worker saw `pushsubscriptionchange`: re-store the (possibly new) subscription.
      navigator.serviceWorker.addEventListener('message', ev => {
        if (ev.data && ev.data.type === 'trailhead-push-resync') syncPushSubscription();
      });
    }
    backend.redirectResult().catch(e => {
      if (!GOOGLE_CANCELLED.includes(e && e.code)) store.authError = "Couldn't sign in: " + (e && e.message ? e.message : e);
    });
    if (typeof window !== 'undefined') {
      window.addEventListener('online', () => { store.online = true; });
      window.addEventListener('offline', () => { store.online = false; });
      document.addEventListener('visibilitychange', () => {
        if (document.hidden) return;
        refreshToday();
        store.notifPermission = currentPermission(); // the user may have changed it in the browser/system settings
        syncPushSubscription();
        syncReminderTz();
      });
      setInterval(refreshToday, 60000);
    }
    watch(unreadCount, n => { if (typeof document !== 'undefined') document.title = documentTitle(n); }, { immediate: true });
    store.notifPermission = currentPermission();
  })();
  return started;
}

/* ---------- auth (Google sign-in, two-person allowlist) ---------- */

// Called by the backend on every auth change: user = null (signed out) or a Google account.
function handleAuth(user) {
  if (!user) {
    stopSync();
    store.me = null;
    store.pushActive = false;
    if (store.authState !== 'denied') { store.user = null; store.authState = 'signedOut'; } // a denial (and the rejected email) stays visible after the forced sign-out
    return;
  }
  const result = resolveUser(user, PEOPLE, { allowLocal: backend.kind === 'local' });
  store.user = { email: user.email || '', displayName: user.displayName || '', photoURL: user.photoURL || '' };
  if (!result.ok) {
    store.me = null;
    store.authError = result.error;
    store.authState = 'denied';
    backend.signOut().catch(() => {});
    return;
  }
  store.me = result.me;
  store.authError = '';
  store.authState = 'signedIn';
  startSync();
  syncPushSubscription(); // silently re-store the subscription if alerts are already allowed (rotated endpoints, new account)
}

// `localPerson` ('a' | 'b') is only used by the dev LocalBackend (?local=1); ignored for Firebase.
export async function signInWithGoogle(localPerson) {
  store.authError = '';
  if (store.authState === 'denied') store.authState = 'signedOut';
  try {
    await backend.signInWithGoogle(localPerson);
  } catch (err) {
    if (GOOGLE_CANCELLED.includes(err && err.code)) return; // user closed the popup: not an error
    store.authError = "Couldn't sign in: " + (err && err.message ? err.message : err);
  }
}

// Also the "Use another account" action on the denied screen.
export async function signOut() {
  await withTimeout(removeMyPushEntry(), 3000).catch(() => {}); // stop pushes for this account on this device
  try { await backend.signOut(); } catch (e) { console.error('Sign out failed:', e); }
  store.authError = '';
  if (store.authState === 'denied') { store.authState = 'signedOut'; store.user = null; }
}

/* ---------- names, settings ---------- */

export async function setName(p, name) {
  if (!validPerson(p)) return;
  const n = String(name || '').trim().slice(0, 18);
  store.names[p] = n || DEFAULT_NAMES[p];
  await settle(n ? backend.set(p === 'a' ? P.nameA : P.nameB, n) : backend.remove(p === 'a' ? P.nameA : P.nameB));
}

export async function setStartDate(iso) {
  if (iso && !isValidISODate(iso)) throw new Error('Invalid date.');
  store.settings.startDate = iso || null;
  await settle(iso ? backend.set(`${P.settings}/startDate`, iso) : backend.remove(`${P.settings}/startDate`));
}

// Per-person plan state (plans/<person>): `patch` may hold any of mode, startDate, raceDate, pauses, skipped, trainingDays,
// weeklyTarget (null clears a field). Validated by planModel.validatePlanPatch (throws an Error with a user-facing message),
// only the provided fields are merged, own plan only (person must be store.me). Optimistic and offline-safe (settle).
// -> the person's new stored state. The legacy global settings/startDate stays the fallback start for both people.
export async function setPlanState(person, patch) {
  const p = validPerson(person);
  if (!p || !backend) throw new Error('Unknown person.');
  if (store.me !== p) throw new Error('You can only change your own plan.');
  const checked = validatePlanPatch(patch);
  if (!checked.ok) throw new Error(checked.error);
  if (!Object.keys(checked.patch).length) return store.plans[p];
  store.plans = { ...store.plans, [p]: normalizePlanState({ [p]: { ...store.plans[p], ...checked.patch } })[p] }; // optimistic, the snapshot confirms
  // Cleared fields (null, empty list) are removed from the database; the defaults come back through normalisation.
  const dbPatch = Object.fromEntries(Object.entries(checked.patch).map(([k, v]) => [k, v === null || (Array.isArray(v) && !v.length) ? null : v]));
  await settle(backend.update(`${P.plans}/${p}`, clean(dbPatch)));
  return store.plans[p];
}

/* ---- plan actions (thin wrappers over setPlanState; own plan only, offline-safe, user-facing error messages) ---- */

// The signed-in person's stored plan state (without the fallback start), for building patches.
const myPlan = () => (store.me ? store.plans[store.me] : null);
const mePerson = () => {
  if (!store.me || !backend) throw new Error('You are not signed in.');
  return store.me;
};
export async function setPlanMode(mode) {
  return setPlanState(mePerson(), { mode });
}

export async function setRaceDate(iso) {
  const me = mePerson();
  const err = raceDateError(iso || null, effectiveStartForPerson(me));
  if (err) throw new Error(err);
  return setPlanState(me, { raceDate: iso || null });
}

export async function setTrainingDays(days) {
  return setPlanState(mePerson(), { trainingDays: Array.isArray(days) ? days : [] });
}

// n: whole number 1..14, or null/'' for automatic.
export async function setWeeklyTarget(n) {
  return setPlanState(mePerson(), { weeklyTarget: n === '' || n === undefined ? null : n });
}

export async function addPause(pause) {
  const me = mePerson();
  const err = pauseError(pause);
  if (err) throw new Error(err);
  return setPlanState(me, addPausePatch(myPlan(), pause));
}

export async function removePause(index) {
  return setPlanState(mePerson(), removePausePatch(myPlan(), index));
}

// sessionId: a plan run id ('1-7-1-a', '1-7-1-a~r2' for the repeat pass) or the alias 'w7-tempo' (rolling.buildSessions).
export async function skipSession(sessionId) {
  return setPlanState(mePerson(), skipSessionPatch(myPlan(), sessionId));
}

export async function unskipSession(sessionId) {
  return setPlanState(mePerson(), unskipSessionPatch(myPlan(), sessionId));
}

// Repeats plan week `weekN` once more right after it (flexible plan); the patch lives in plans/<me>/repeatWeeks.
export async function repeatWeek(weekN) {
  return setPlanState(mePerson(), repeatWeekPatch(myPlan(), weekN));
}

export async function unrepeatWeek(weekN) {
  return setPlanState(mePerson(), unrepeatWeekPatch(myPlan(), weekN));
}

// Daily run reminder (settings/reminders/<me>). Only enabled/time/tz/updatedTs are merged in (the Worker owns
// lastSentDate), plus lastSentDate = today when an enabled time has already passed today in the person's zone, so
// enabling at 21:00 for 20:00 does not fire at once. `time` is validated ('HH:MM') and rounded to 5 minutes;
// omitted fields keep their current value. Throws on invalid input; offline writes are queued (settle).
export async function setReminder({ enabled, time } = {}) {
  const me = validPerson(store.me);
  if (!me || !backend) throw new Error('You are not signed in.');
  const cur = store.reminders[me];
  let t = cur.time;
  if (time !== undefined && time !== null) {
    if (!isValidTime(time)) throw new Error('Enter a time like 07:30.');
    t = roundTime(time);
  }
  const tz = deviceTimeZone() || cur.tz || 'UTC';
  const patch = buildReminderPatch({ enabled: enabled === undefined ? cur.enabled : !!enabled, time: t, tz });
  store.reminders[me] = { ...cur, ...patch }; // optimistic, the snapshot confirms
  await settle(backend.update(`${P.reminders}/${me}`, clean(patch)));
  return store.reminders[me];
}

// Travel: when reminders are on and this device is in another time zone than the stored one, silently store the new zone.
let tzSyncing = '';
async function syncReminderTz() {
  const me = validPerson(store.me);
  const tz = deviceTimeZone();
  if (!me || !backend || !remindersLoaded || !isValidTimeZone(tz)) return;
  const cur = store.reminders[me];
  if (!cur.enabled || cur.tz === tz || tzSyncing === tz) return;
  tzSyncing = tz;
  try { await settle(backend.update(`${P.reminders}/${me}`, { tz, updatedTs: Date.now() })); }
  catch (e) { console.warn('Could not update the reminder time zone:', e); }
  finally { tzSyncing = ''; }
}

// Plan-km override in the legacy format (string under goals/<runId>); empty string clears the override.
export async function setGoal(runId, kmString) {
  if (!PLAN_RUN_BY_ID[runId]) throw new Error('Unknown run.');
  const v = String(kmString == null ? '' : kmString).trim();
  const n = parseFloat(v.replace(',', '.'));
  if (v !== '' && !(Number.isFinite(n) && n >= 0)) throw new Error('Distance must be 0 or more.');
  if (v === '') {
    const { [runId]: _drop, ...rest } = store.goals; store.goals = rest;
    await settle(backend.remove(`${P.goals}/${runId}`));
  } else {
    store.goals = { ...store.goals, [runId]: v };
    await settle(backend.set(`${P.goals}/${runId}`, v));
  }
}

/* ---------- events ---------- */

// The write starts immediately (callers collect the promises and `settle` them together, so ordering is kept and a
// pending offline write cannot block the next one). Once the event is acknowledged the Worker is told to push it.
async function pushEvent(kind, text, refId) {
  const id = backend.newKey(P.events);
  await backend.set(`${P.events}/${id}`, clean({ id, actor: store.me, kind, text, refId, ts: Date.now() }));
  sendPush(id); // fire-and-forget: the Worker pushes this event to the other person's devices
  return id;
}

// Never awaited by callers, never throws; failures are only logged (see push.js notifyWorker).
function sendPush(eventId) {
  return notifyWorker({
    pushUrl: PUSH_URL, backendKind: backend && backend.kind, eventId, getIdToken: () => backend.getIdToken()
  });
}

/* ---------- activities ---------- */

export async function addActivity(input) {
  if (!store.me) throw new Error('You are not signed in.');
  const checked = validateActivityInput(input);
  if (!checked.ok) throw new Error(checked.error);
  const me = store.me;
  const id = backend.newKey(P.log);
  const photo = input.photoDataUrl || null;
  const entry = { id, person: me, ...checked.value, hasPhoto: !!photo, ts: Date.now() };
  if (entry.session && !sessionPinAllowed(entry.session, me)) delete entry.session; // only your own plan's sessions (or 'free')

  // Week fulfilment before/after, to detect a week that just became fulfilled.
  const isFulfilled = (log, e) => weekFulfillment({
    entry: e, log, person: me, goals: store.goals, settingsStartDate: store.settings.startDate, planState: store.plans, today: today.value
  });
  const after = entry.sport === 'run' ? isFulfilled([...store.log, entry], entry) : { n: null, done: false };
  const before = entry.sport === 'run' && after.n ? isFulfilled(store.log, entry) : { done: false };
  // (If the plan start shifts because this is the earliest run, `before` uses the old mapping on purpose.)
  let weekJustDone = after.done && !(before.done && before.n === after.n);
  // Flexible plan: the run completes the week of its session, whatever its date says.
  const rolled = entry.sport === 'run'
    ? rollingNewlyFulfilledWeek({ beforeLog: store.log, afterLog: [...store.log, entry], person: me, goals: store.goals, settingsStartDate: store.settings.startDate, planState: store.plans, today: today.value })
    : undefined;
  if (rolled !== undefined) { weekJustDone = rolled !== null; after.n = rolled; }

  // All writes are issued back to back (the SDK keeps their order); awaiting each ack would hang offline.
  const name = store.names[me];
  const writes = [];
  if (photo) { writes.push(backend.set(`${P.photos}/${id}`, photo)); photoCache.set(id, photo); }
  writes.push(backend.set(`${P.log}/${id}`, clean(entry)));
  writes.push(pushEvent('activity', activityEventText(name, entry), id));
  if (weekJustDone && !hasWeekEvent(store.events, me, after.n)) writes.push(pushEvent('week', weekEventText(name, after.n), id));
  await settle(Promise.all(writes));
  return id;
}

// Edits `id` (own entries only). `input` has the addActivity shape plus `removePhoto: true`; no photo key keeps the photo.
// Only changed fields are written (never person, id, ts, kudos, imported), with `editedTs`. No event for a plain edit,
// except the 'week' event when the edit makes the plan week newly fulfilled.
export async function updateActivity(id, input) {
  if (!store.me) throw new Error('You are not signed in.');
  const entry = store.log.find(e => e.id === id);
  if (!entry) throw new Error('That activity no longer exists.');
  if (entry.person !== store.me) throw new Error('You can only edit your own activities.');
  const prepared = prepareEdit(entry, input, { today: today.value });
  if (!prepared.ok) throw new Error(prepared.error);
  if (!prepared.changed) return id;
  const me = store.me;
  const editedTs = Date.now();
  // (Any sport: turning a run into a cycle can re-shuffle which sessions the remaining runs take.)
  const rolled = rollingNewlyFulfilledWeek({
    beforeLog: store.log, afterLog: store.log.map(e => (e.id === id ? prepared.next : e)), person: me, goals: store.goals,
    settingsStartDate: store.settings.startDate, planState: store.plans, today: today.value
  });
  const weekN = rolled !== undefined ? rolled : newlyFulfilledWeek({
    entry, next: prepared.next, log: store.log, goals: store.goals, settingsStartDate: store.settings.startDate, planState: store.plans, today: today.value
  });

  // Photo first, then the entry (so hasPhoto never points at a missing photo); issued back to back like addActivity.
  const writes = [];
  if (prepared.photo === 'set') {
    writes.push(backend.set(`${P.photos}/${id}`, input.photoDataUrl));
    photoCache.set(id, input.photoDataUrl);
    ownPhotoEdits.set(id, editedTs);
  } else if (prepared.photo === 'remove') {
    writes.push(backend.remove(`${P.photos}/${id}`));
    photoCache.delete(id);
  }
  writes.push(backend.update(`${P.log}/${id}`, clean({ ...prepared.patch, editedTs })));
  if (weekN && !hasWeekEvent(store.events, me, weekN)) writes.push(pushEvent('week', weekEventText(store.names[me], weekN), id));
  await settle(Promise.all(writes));
  return id;
}

// A photo replaced on another device must not keep showing the old cached one (our own edits already cached the new one).
const ownPhotoEdits = new Map();
function dropStalePhotos(prev, next) {
  const before = new Map((prev || []).map(e => [e.id, e]));
  for (const e of next) {
    const old = before.get(e.id);
    if (!old || old.editedTs === e.editedTs || ownPhotoEdits.get(e.id) === e.editedTs) continue;
    photoCache.delete(e.id);
  }
}

export async function deleteActivity(id) {
  const entry = store.log.find(e => e.id === id);
  if (!entry || entry.person !== store.me) return;
  // The entry takes its kudos (they live inside it), its photo and the events that point at it along.
  const writes = [backend.remove(`${P.log}/${id}`)];
  if (entry.hasPhoto) writes.push(backend.remove(`${P.photos}/${id}`));
  for (const ev of store.events) if (ev.refId === id) writes.push(backend.remove(`${P.events}/${ev.id}`));
  photoCache.delete(id);
  await settle(Promise.all(writes));
}

export async function toggleKudos(id) {
  const entry = store.log.find(e => e.id === id);
  if (!entry || !store.me) return;
  const path = `${P.log}/${id}/kudos/${store.me}`;
  if (entry.kudos && entry.kudos[store.me]) { await settle(backend.remove(path)); return; }
  const writes = [backend.set(path, true)];
  // One kudos event per person and entry: toggling kudos off and on again must not ping the owner repeatedly.
  const already = store.events.some(ev => ev.kind === 'kudos' && ev.actor === store.me && ev.refId === id);
  if (entry.person !== store.me && !already) writes.push(pushEvent('kudos', kudosEventText(store.names[store.me], entry), id));
  await settle(Promise.all(writes));
}

export async function loadPhoto(id) {
  if (photoCache.has(id)) return photoCache.get(id);
  try {
    const v = await backend.get(`${P.photos}/${id}`);
    if (v) photoCache.set(id, v);
    return v || null;
  } catch (e) {
    console.error('Could not load photo:', e);
    return null;
  }
}

/* ---------- notes (message board, unchanged format) ---------- */

export async function postNote({ text, imageDataUrl } = {}) {
  const t = String(text || '').trim();
  if (!t && !imageDataUrl) return;
  if (!store.me) throw new Error('You are not signed in.');
  const payload = { sender: store.me, name: store.names[store.me], text: t, image: imageDataUrl || null, ts: Date.now() };
  try {
    await settle(backend.push(P.messages, payload));
  } catch (e) {
    console.error('Could not post message:', e);
    throw new Error(e && e.code === 'PERMISSION_DENIED'
      ? 'Permission denied — check that your Realtime Database rules allow writes.'
      : "Couldn't send — check your connection and try again.");
  }
  settle(pushEvent('note', noteEventText(store.names[store.me], t))).catch(e => console.error('Could not emit note event:', e));
}

export async function deleteNote(key) {
  await settle(backend.remove(`${P.messages}/${key}`));
}

/* ---------- notifications / toasts ---------- */

let toastSeq = 0;

export function pushToast(text, kind = 'info', actor = null) {
  const id = `t${Date.now()}-${++toastSeq}`;
  store.toasts.push({ id, text, kind, actor });
  setTimeout(() => dismissToast(id), TOAST_MS);
  return id;
}

export function dismissToast(id) {
  const i = store.toasts.findIndex(t => t.id === id);
  if (i >= 0) store.toasts.splice(i, 1);
}

export function markEventsRead() {
  store.lastReadTs = nextLastRead(store.events);
  saveLastRead(store.lastReadTs);
}

/* ---------- system notifications / Web Push ---------- */

const PUSH_OFF_KEY = 'trailhead-push-off'; // set when the user turned alerts off on this device: no silent re-subscribe
const pushOptedOut = () => { try { return localStorage.getItem(PUSH_OFF_KEY) === '1'; } catch (e) { return false; } };
const setPushOptedOut = on => { try { on ? localStorage.setItem(PUSH_OFF_KEY, '1') : localStorage.removeItem(PUSH_OFF_KEY); } catch (e) { /* ignore */ } };
const pushAvailable = () => !!(backend && backend.kind === 'firebase' && VAPID_PUBLIC_KEY && isPushSupported());
const other = p => (p === 'a' ? 'b' : 'a');
const withTimeout = (promise, ms) => Promise.race([promise, new Promise((_, rej) => setTimeout(() => rej(new Error('timeout')), ms))]);

// Make sure this device has a push subscription and that it is stored under pushSubs/<me>/<hash>.
// Needs permission already granted; never prompts. Throws on real failures (callers decide whether to show them).
async function storePushSubscription() {
  const me = store.me;
  const sub = await subscribeToPush(VAPID_PUBLIC_KEY);
  const record = subscriptionRecord(sub);
  if (!record) throw new Error('The browser returned an incomplete push subscription.');
  const hash = await endpointHash(record.endpoint);
  await backend.set(`${P.pushSubs}/${me}/${hash}`, record);
  // A shared device that was used by the other person before must not keep receiving their pushes.
  backend.remove(`${P.pushSubs}/${other(me)}/${hash}`).catch(() => {});
  store.pushActive = true;
}

// Silent re-sync (every sign-in, and when the service worker reports a changed subscription).
export async function syncPushSubscription() {
  if (!store.me || !pushAvailable() || currentPermission() !== 'granted' || pushOptedOut()) return;
  store.notifPermission = 'granted';
  store.pushBusy = true;
  try { await storePushSubscription(); }
  catch (e) { store.pushActive = false; console.warn('Push re-sync failed:', e); }
  finally { store.pushBusy = false; }
}

// Removes this device's database entry for the signed-in account (keeps the browser subscription).
async function removeMyPushEntry() {
  if (!backend || backend.kind !== 'firebase' || !store.me || !isPushSupported()) return;
  const sub = await currentSubscription();
  if (sub) await backend.remove(`${P.pushSubs}/${store.me}/${await endpointHash(sub.endpoint)}`);
}

// Call from a click/tap handler (browsers require a user gesture): asks for permission first, then subscribes.
export async function enableSystemNotifications() {
  setPushOptedOut(false);
  store.notifPermission = await requestPermission();
  if (store.notifPermission !== 'granted') return;
  if (!pushAvailable() || !store.me) { pushToast('Alerts enabled while the app is open', 'info'); return; }
  store.pushBusy = true;
  try {
    await storePushSubscription();
    pushToast('Alerts enabled on this device', 'info');
  } catch (e) {
    store.pushActive = false;
    console.warn('Push setup failed:', e);
    pushToast("Alerts are allowed, but push setup failed. Reload and try again.", 'info');
  } finally { store.pushBusy = false; }
}

// Unsubscribe this device and remove its database entry. Browser permission stays granted (revoke it in site settings).
export async function disableSystemNotifications() {
  setPushOptedOut(true);
  store.pushBusy = true;
  try {
    const endpoint = await unsubscribeFromPush();
    if (endpoint && backend && backend.kind === 'firebase' && store.me) {
      await backend.remove(`${P.pushSubs}/${store.me}/${await endpointHash(endpoint)}`);
    }
    store.pushActive = false;
    pushToast('Alerts turned off on this device', 'info');
  } catch (e) {
    console.warn('Turning off push failed:', e);
    pushToast("Couldn't turn off alerts. Try again.", 'info');
  } finally { store.pushBusy = false; }
}

// Settings: ask the Worker for a test push to this person's devices ('self'), the other person's ('other'), or this
// person's daily run reminder with today's recommendation ('reminder').
// Never throws; the outcome lands in store.testPush for the Settings banner.
export async function sendTestNotification(target) {
  if (store.testPush.busy) return;
  const done = (kind, message) => { store.testPush.kind = kind; store.testPush.message = message; };
  if (!backend || backend.kind !== 'firebase') { pushToast('Local mode: no real push', 'info'); return; }
  if (target === 'self' && !store.pushActive) { done('warning', 'Enable alerts on this device first'); return; }
  store.testPush.busy = true;
  store.testPush.message = '';
  try {
    const r = await sendTestPush(target, { url: PUSH_URL, getToken: () => backend.getIdToken() });
    const m = testPushMessage(r, target);
    done(m.kind, m.message);
  } finally { store.testPush.busy = false; }
}
