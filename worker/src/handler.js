// Request handling with injected dependencies (fetch, now, getCerts, seen) so it is testable without network.
import { AuthError, verifyFirebaseIdToken } from './firebaseToken.js';
import { corsHeaders, originAllowed } from './cors.js';
import { importVapidPrivateKey, sendWebPush } from './webpush.js';

export const DB_ROOT = 'trailhead-tracker-v1';
export const MAX_EVENT_AGE_MS = 5 * 60 * 1000;
const MAX_FUTURE_SKEW_MS = 2 * 60 * 1000;
const MAX_SUBS = 10;
const EVENT_ID = /^[A-Za-z0-9_-]{1,64}$/;

export class HttpError extends Error {
  constructor(status, message) { super(message); this.status = status; }
}

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

const dbUrl = (env, path, token) =>
  `${String(env.DB_URL).replace(/\/+$/, '')}/${path}.json?auth=${encodeURIComponent(token)}`;

async function dbGet(fetchFn, env, path, token) {
  const res = await fetchFn(dbUrl(env, path, token), { headers: { Accept: 'application/json' } });
  if (res.status === 401 || res.status === 403) throw new HttpError(403, 'database denied access');
  if (!res.ok) throw new HttpError(502, `database error ${res.status}`);
  return res.json();
}

// { [hash]: {endpoint, keys, ts} } or the legacy single object -> [{ path, endpoint, keys }]
export function normalizeSubs(raw, recipient) {
  if (!raw || typeof raw !== 'object') return [];
  const valid = s => s && typeof s === 'object' && typeof s.endpoint === 'string' && s.keys &&
    typeof s.keys.p256dh === 'string' && typeof s.keys.auth === 'string' && s.endpoint.startsWith('https://');
  if (valid(raw)) return [{ path: `${DB_ROOT}/pushSubs/${recipient}`, endpoint: raw.endpoint, keys: raw.keys }];
  return Object.keys(raw).filter(k => /^[A-Za-z0-9_-]{1,128}$/.test(k) && valid(raw[k])).slice(0, MAX_SUBS)
    .map(k => ({ path: `${DB_ROOT}/pushSubs/${recipient}/${k}`, endpoint: raw[k].endpoint, keys: raw[k].keys }));
}

export function buildPayload(event, eventId) {
  const text = String(event.text || '').replace(/\s+/g, ' ').trim();
  return { title: 'Trailhead', body: text.length > 200 ? text.slice(0, 199) + '…' : text, tag: eventId, url: '/' };
}

async function notify(request, env, deps) {
  const { fetchFn, now, getCerts, seen } = deps;
  const m = /^Bearer ([^\s]+)$/.exec(request.headers.get('Authorization') || '');
  if (!m) throw new AuthError('missing bearer token');
  const idToken = m[1];

  let body;
  try { body = await request.json(); } catch { throw new HttpError(400, 'body must be JSON'); }
  const eventId = body && body.eventId;
  if (typeof eventId !== 'string' || !EVENT_ID.test(eventId)) throw new HttpError(400, 'invalid eventId');

  const who = await verifyFirebaseIdToken(idToken, {
    projectId: env.PROJECT_ID, personAEmail: env.PERSON_A_EMAIL, personBEmail: env.PERSON_B_EMAIL, getCerts, now
  });

  const event = await dbGet(fetchFn, env, `${DB_ROOT}/events/${eventId}`, idToken);
  if (!event || typeof event !== 'object') throw new HttpError(404, 'event not found');
  if (event.actor !== who.person) throw new HttpError(403, 'event does not belong to caller');
  const t = now();
  if (typeof event.ts !== 'number' || !Number.isFinite(event.ts)) throw new HttpError(400, 'event has no timestamp');
  if (t - event.ts > MAX_EVENT_AGE_MS) throw new HttpError(410, 'event too old');
  if (event.ts - t > MAX_FUTURE_SKEW_MS) throw new HttpError(400, 'event timestamp in the future');

  if (!claim(seen, eventId, t)) return { sent: 0, removed: 0, duplicate: true };

  try {
    const recipient = other(who.person);
    const subs = normalizeSubs(await dbGet(fetchFn, env, `${DB_ROOT}/pushSubs/${recipient}`, idToken), recipient);
    if (!subs.length) return { sent: 0, removed: 0 };

    let privateKey;
    try { privateKey = await importVapidPrivateKey(env.VAPID_PRIVATE_KEY, env.VAPID_PUBLIC_KEY); }
    catch { throw new HttpError(500, 'push is not configured on the server'); }
    const payload = JSON.stringify(buildPayload(event, eventId));

    const results = await Promise.all(subs.map(async s => {
      try {
        const r = await sendWebPush({ endpoint: s.endpoint, keys: s.keys }, payload,
          { fetchFn, subject: env.VAPID_SUBJECT, publicKey: env.VAPID_PUBLIC_KEY, privateKey, now });
        if (r.gone) {
          try { await fetchFn(dbUrl(env, s.path, idToken), { method: 'DELETE' }); } catch { /* best effort */ }
        }
        return r;
      } catch { return { ok: false, gone: false }; }
    }));
    const sent = results.filter(r => r.ok).length;
    if (sent === 0 && results.some(r => !r.gone)) seen.delete(eventId); // transient failure: allow a retry
    return { sent, removed: results.filter(r => r.gone).length };
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
    if (url.pathname === '/health' && request.method === 'GET') return json({ ok: true }, 200, cors);
    if (url.pathname === '/notify') {
      if (request.method !== 'POST') return json({ error: 'method not allowed' }, 405, { ...cors, Allow: 'POST, OPTIONS' });
      return json(await notify(request, env, deps), 200, cors);
    }
    return json({ error: 'not found' }, 404, cors);
  } catch (e) {
    if (e instanceof AuthError || e instanceof HttpError) return json({ error: e.message }, e.status, cors);
    return json({ error: 'internal error' }, 500, cors);
  }
}
