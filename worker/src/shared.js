// Database access and Web Push delivery shared by the request handler (/notify) and the scheduled reminders.
// `auth` is either a Firebase ID token string (sent as ?auth=, the caller's own rights) or { bearer } (an OAuth2
// access token of the service account, sent as an Authorization header, used by the cron which has no user).
import { importVapidPrivateKey, sendWebPush } from './webpush.js';

export const DB_ROOT = 'trailhead-tracker-v1';
const MAX_SUBS = 10;

export class HttpError extends Error {
  constructor(status, message, headers = {}) { super(message); this.status = status; this.headers = headers; }
}

export const dbUrl = (env, path, auth) => {
  const base = `${String(env.DB_URL).replace(/\/+$/, '')}/${path}.json`;
  return typeof auth === 'string' ? `${base}?auth=${encodeURIComponent(auth)}` : base;
};

function dbInit(auth, init = {}) {
  if (typeof auth === 'string') return init;
  return { ...init, headers: { ...(init.headers || {}), Authorization: `Bearer ${auth.bearer}` } };
}

export async function dbGet(fetchFn, env, path, auth) {
  const res = await fetchFn(dbUrl(env, path, auth), dbInit(auth, { headers: { Accept: 'application/json' } }));
  if (res.status === 401 || res.status === 403) throw new HttpError(403, 'database denied access');
  if (!res.ok) throw new HttpError(502, `database error ${res.status}`);
  return res.json();
}

// PATCH (merge) `obj` into `path`; throws unless the database accepted it.
export async function dbPatch(fetchFn, env, path, auth, obj) {
  const res = await fetchFn(dbUrl(env, path, auth), dbInit(auth, {
    method: 'PATCH', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(obj)
  }));
  try { await res.arrayBuffer(); } catch { /* drain */ }
  if (!res.ok) throw new HttpError(res.status === 401 || res.status === 403 ? 403 : 502, `database write failed ${res.status}`);
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

export async function loadSubs(fetchFn, env, auth, recipient) {
  return normalizeSubs(await dbGet(fetchFn, env, `${DB_ROOT}/pushSubs/${recipient}`, auth), recipient);
}

export async function loadVapidKey(env) {
  try { return await importVapidPrivateKey(env.VAPID_PRIVATE_KEY, env.VAPID_PUBLIC_KEY); }
  catch { throw new HttpError(500, 'push is not configured on the server'); }
}

// Sends `payload` to each subscription; dead ones (404/410) are deleted. -> { sent, removed, transient }
// (transient: nothing was delivered and at least one failure is worth retrying)
export async function sendToSubs({ fetchFn, env, now, auth, subs, payload, privateKey }) {
  const body = JSON.stringify(payload);
  const results = await Promise.all(subs.map(async s => {
    try {
      const r = await sendWebPush({ endpoint: s.endpoint, keys: s.keys }, body,
        { fetchFn, subject: env.VAPID_SUBJECT, publicKey: env.VAPID_PUBLIC_KEY, privateKey, now });
      if (r.gone) {
        try { await fetchFn(dbUrl(env, s.path, auth), dbInit(auth, { method: 'DELETE' })); } catch { /* best effort */ }
      }
      return r;
    } catch { return { ok: false, gone: false }; }
  }));
  const sent = results.filter(r => r.ok).length;
  return { sent, removed: results.filter(r => r.gone).length, transient: sent === 0 && results.some(r => !r.gone) };
}

// Reads the recipient's subscriptions and sends `payload` to each.
// -> { noSubs } | { sent, removed, transient }
export async function deliver({ fetchFn, env, now, auth, recipient, payload }) {
  const subs = await loadSubs(fetchFn, env, auth, recipient);
  if (!subs.length) return { noSubs: true };
  const privateKey = await loadVapidKey(env);
  return sendToSubs({ fetchFn, env, now, auth, subs, payload, privateKey });
}
