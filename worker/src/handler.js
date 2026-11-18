// Request handling with injected dependencies (fetch, now, getCerts, seen) so it is testable without network.
import { AuthError, verifyFirebaseIdToken } from './firebaseToken.js';
import { corsHeaders, originAllowed } from './cors.js';
import { DB_ROOT, HttpError, dbGet, deliver, loadSubs, loadVapidKey, normalizeSubs, sendToSubs } from './shared.js';
import { parseServiceAccount } from './serviceAccount.js';
import { localParts, recommendationFromDb } from './reminders.js';
import { reminderMessage } from '../../src/recommendForPerson.js';

export { DB_ROOT, HttpError, normalizeSubs };
export const MAX_EVENT_AGE_MS = 5 * 60 * 1000;
const MAX_FUTURE_SKEW_MS = 2 * 60 * 1000;
const TEST_INTERVAL_MS = 10 * 1000;
const EVENT_ID = /^[A-Za-z0-9_-]{1,64}$/;

const json = (obj, status, extra = {}) =>
  new Response(JSON.stringify(obj), { status, headers: { 'Content-Type': 'application/json', 'Cache-Control': 'no-store', ...extra } });

const other = p => (p === 'a' ? 'b' : 'a');

// Best-effort replay guard, one Map per isolate: eventId -> first-seen ms.
export const defaultSeen = new Map();
function claim(seen, id, now) {
  for (const [k, t] of seen) if (now - t > 2 * MAX_EVENT_AGE_MS) seen.delete(k);
  if (seen.has(id)) return false;
  seen.set(id, now);
  return true;
}

export function buildPayload(event, eventId) {
  const text = String(event.text || '').replace(/\s+/g, ' ').trim();
  return { title: 'Trailhead', body: text.length > 200 ? text.slice(0, 199) + '…' : text, tag: eventId, url: '/' };
}

// Best-effort per-isolate limiter for test pushes: actor -> last test ms. Returns seconds to wait, or 0 if allowed (and records).
export const defaultTestSeen = new Map();
function claimTest(map, actor, now) {
  for (const [k, t] of map) if (now - t > TEST_INTERVAL_MS) map.delete(k);
  const last = map.get(actor);
  if (last !== undefined && now - last < TEST_INTERVAL_MS) return Math.ceil((TEST_INTERVAL_MS - (now - last)) / 1000);
  map.set(actor, now);
  return 0;
}

// Names used in the "other" test text; the database values (nameA/nameB) win, read with the caller's token.
const DEFAULT_NAMES = { a: 'Beatrix', b: 'Julian' };
async function callerName(fetchFn, env, person, idToken) {
  try {
    const v = await dbGet(fetchFn, env, `${DB_ROOT}/name${person.toUpperCase()}`, idToken);
    const n = typeof v === 'string' ? v.replace(/\s+/g, ' ').trim().slice(0, 40) : '';
    if (n) return n;
  } catch { /* fall back to the default */ }
  return DEFAULT_NAMES[person];
}

export function buildTestPayload(target, callerDisplayName) {
  const body = target === 'self'
    ? 'Test notification \u2014 push is working on this device \u{1F389}'
    : `${callerDisplayName} sent you a test notification`;
  return { title: 'Trailhead', body, tag: 'trailhead-test', url: '/' };
}

// {"test":"reminder"}: the caller's OWN recommendation, built with the caller's token, pushed to the caller's own devices now.
async function notifyReminderTest(who, idToken, env, deps) {
  const { fetchFn, now } = deps;
  const settings = await dbGet(fetchFn, env, `${DB_ROOT}/settings`, idToken);
  const cfg = settings && settings.reminders && settings.reminders[who.person];
  const todayISO = localParts(now(), cfg && cfg.tz).date;
  const { rec, name } = await recommendationFromDb({ fetchFn, env, auth: idToken, person: who.person, todayISO, settings: settings || {} });
  const kind = rec.kind;
  const rest = kind === 'run' ? {} : { rest: true }; // no run today: the test message says so (the app shows an info line)
  const subs = await loadSubs(fetchFn, env, idToken, who.person);
  if (!subs.length) return { sent: 0, removed: 0, target: 'self', kind, ...rest, reason: 'no-subscription' };
  const privateKey = await loadVapidKey(env);
  const r = await sendToSubs({ fetchFn, env, now, auth: idToken, subs, payload: reminderMessage(rec, name), privateKey });
  return { sent: r.sent, removed: r.removed, target: 'self', kind, ...rest };
}

async function notifyTest(target, who, idToken, env, deps) {
  const { fetchFn, now } = deps;
  const wait = claimTest(deps.testSeen || defaultTestSeen, who.person, now());
  if (wait) throw new HttpError(429, 'too many test notifications, wait a few seconds', { 'Retry-After': String(wait) });
  if (target === 'reminder') return notifyReminderTest(who, idToken, env, deps);

  const recipient = target === 'self' ? who.person : other(who.person);
  const name = target === 'other' ? await callerName(fetchFn, env, who.person, idToken) : null;
  const r = await deliver({ fetchFn, env, now, auth: idToken, recipient, payload: buildTestPayload(target, name) });
  if (r.noSubs) return { sent: 0, removed: 0, target, reason: 'no-subscription' };
  return { sent: r.sent, removed: r.removed, target };
}

async function notify(request, env, deps) {
  const { fetchFn, now, getCerts, seen } = deps;
  const m = /^Bearer ([^\s]+)$/.exec(request.headers.get('Authorization') || '');
  if (!m) throw new AuthError('missing bearer token');
  const idToken = m[1];

  let body;
  try { body = await request.json(); } catch { throw new HttpError(400, 'body must be JSON'); }
  const isTest = !!body && typeof body === 'object' && body.test !== undefined;
  const eventId = body && body.eventId;
  if (isTest) {
    if (body.test !== 'self' && body.test !== 'other' && body.test !== 'reminder') throw new HttpError(400, 'invalid test target');
  } else if (typeof eventId !== 'string' || !EVENT_ID.test(eventId)) throw new HttpError(400, 'invalid eventId');

  const who = await verifyFirebaseIdToken(idToken, {
    projectId: env.PROJECT_ID, personAEmail: env.PERSON_A_EMAIL, personBEmail: env.PERSON_B_EMAIL, getCerts, now
  });

  if (isTest) return notifyTest(body.test, who, idToken, env, deps);

  const event = await dbGet(fetchFn, env, `${DB_ROOT}/events/${eventId}`, idToken);
  if (!event || typeof event !== 'object') throw new HttpError(404, 'event not found');
  if (event.actor !== who.person) throw new HttpError(403, 'event does not belong to caller');
  const t = now();
  if (typeof event.ts !== 'number' || !Number.isFinite(event.ts)) throw new HttpError(400, 'event has no timestamp');
  if (t - event.ts > MAX_EVENT_AGE_MS) throw new HttpError(410, 'event too old');
  if (event.ts - t > MAX_FUTURE_SKEW_MS) throw new HttpError(400, 'event timestamp in the future');

  if (!claim(seen, eventId, t)) return { sent: 0, removed: 0, duplicate: true };

  try {
    const r = await deliver({ fetchFn, env, now, auth: idToken, recipient: other(who.person), payload: buildPayload(event, eventId) });
    if (r.noSubs) return { sent: 0, removed: 0 };
    if (r.transient) seen.delete(eventId); // transient failure: allow a retry
    return { sent: r.sent, removed: r.removed };
  } catch (e) {
    seen.delete(eventId);
    throw e;
  }
}

export async function handleRequest(request, env, deps) {
  const origin = request.headers.get('Origin');
  const url = new URL(request.url);
  let cors = {};
  if (origin) {
    if (!originAllowed(origin, env.ALLOWED_ORIGINS)) return json({ error: 'origin not allowed' }, 403);
    cors = corsHeaders(origin);
  }
  if (request.method === 'OPTIONS') return new Response(null, { status: 204, headers: cors });
  try {
    if (url.pathname === '/health' && request.method === 'GET') return json({ ok: true, scheduler: !!parseServiceAccount(env.FIREBASE_SERVICE_ACCOUNT) }, 200, cors);
    if (url.pathname === '/notify') {
      if (request.method !== 'POST') return json({ error: 'method not allowed' }, 405, { ...cors, Allow: 'POST, OPTIONS' });
      return json(await notify(request, env, deps), 200, cors);
    }
    return json({ error: 'not found' }, 404, cors);
  } catch (e) {
    if (e instanceof AuthError || e instanceof HttpError) return json({ error: e.message }, e.status, { ...cors, ...(e.headers || {}) });
    return json({ error: 'internal error' }, 500, cors);
  }
}
