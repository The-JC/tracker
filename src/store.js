// Reactive singleton store + actions: the contract UI components code against (docs/REBUILD_PLAN.md §6).
// All business logic lives in the pure modules (scoring/plan/migration/notifications); this file only
// wires them to Vue reactivity and the backend.
import { reactive, computed, ref, watch } from 'vue';
import { PLAN, PLAN_RUN_BY_ID } from './plan.js';
import {
  todayISO, isValidISODate, effectiveStartDate as calcStartDate, buildWeeks, scoreboard as calcScoreboard,
  stats as calcStats, sortLog, validateActivityInput, weekOfEntry
} from './scoring.js';
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
import { prepareEdit, newlyFulfilledWeek, hasWeekEvent } from './utils/entryPatch.js';

const DEFAULT_NAMES = { a: PEOPLE.a.name, b: PEOPLE.b.name };
const P = {
  nameA: `${DB_ROOT}/nameA`, nameB: `${DB_ROOT}/nameB`, goals: `${DB_ROOT}/goals`, checks: `${DB_ROOT}/checks`,
  activities: `${DB_ROOT}/activities`, settings: `${DB_ROOT}/settings`, log: `${DB_ROOT}/log`,
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

export const effectiveStartDate = computed(() => calcStartDate(store.settings.startDate, store.log, today.value));
export const weeks = computed(() => buildWeeks(PLAN, store.goals, store.log, effectiveStartDate.value, today.value));
export const scoreboard = computed(() => calcScoreboard(store.log, weeks.value, today.value));
export const stats = computed(() => calcStats(store.log, today.value));
export const unreadCount = computed(() => unreadEvents(store.events, store.me, store.lastReadTs).length);

/* ---------- backend wiring ---------- */

let backend = null;
let started = null; // promise, so initStore() is idempotent
let unsubs = [];
let knownEventIds = null; // null until the first events snapshot (baseline, no toasts)
let migrationTried = false;
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

  // Week fulfilment before/after, to detect a week that just became fulfilled.
  const isFulfilled = (log, e) => {
    const start = calcStartDate(store.settings.startDate, log, today.value);
    const n = weekOfEntry(e, start);
    if (!n || n > PLAN.length) return { n: null, done: false };
    const w = buildWeeks(PLAN, store.goals, log, start, today.value)[n - 1];
    return { n, done: w[me].status === 'fulfilled' };
  };
  const after = entry.sport === 'run' ? isFulfilled([...store.log, entry], entry) : { n: null, done: false };
  const before = entry.sport === 'run' && after.n ? isFulfilled(store.log, entry) : { done: false };
  // (If the plan start shifts because this is the earliest run, `before` uses the old mapping on purpose.)
  const weekJustDone = after.done && !(before.done && before.n === after.n);

  // All writes are issued back to back (the SDK keeps their order); awaiting each ack would hang offline.
  const name = store.names[me];
  const writes = [];
  if (photo) { writes.push(backend.set(`${P.photos}/${id}`, photo)); photoCache.set(id, photo); }
  writes.push(backend.set(`${P.log}/${id}`, clean(entry)));
  writes.push(pushEvent('activity', activityEventText(name, entry), id));
  if (weekJustDone) writes.push(pushEvent('week', weekEventText(name, after.n), id));
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
  const weekN = newlyFulfilledWeek({
    entry, next: prepared.next, log: store.log, goals: store.goals, settingsStartDate: store.settings.startDate, today: today.value
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

// Settings: ask the Worker for a test push to this person's devices ('self') or the other person's ('other').
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
