// Web Push client helpers. The top half is pure (node-tested); the browser half touches
// navigator/window only inside functions, so importing this module in node is safe.
//
// Contract with the Cloudflare Worker (worker/README.md): subscriptions live at
// trailhead-tracker-v1/pushSubs/<me>/<endpointHash> = { endpoint, keys: { p256dh, auth }, ts },
// and after writing an event the client POSTs {"eventId"} to <PUSH_URL>/notify with a Firebase ID token.

/* ---------- pure helpers ---------- */

// base64url (VAPID public key) -> Uint8Array, as required by pushManager.subscribe({ applicationServerKey }).
export function urlBase64ToUint8Array(b64) {
  const s = String(b64 || '').trim().replace(/-/g, '+').replace(/_/g, '/');
  const padded = s + '='.repeat((4 - (s.length % 4)) % 4);
  const bin = atob(padded);
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return out;
}

// Uint8Array/ArrayBuffer -> base64url (no padding).
export function uint8ToUrlBase64(buf) {
  const bytes = buf instanceof Uint8Array ? buf : new Uint8Array(buf);
  let bin = '';
  for (const b of bytes) bin += String.fromCharCode(b);
  return btoa(bin).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

// Stable database key for a device: first 32 hex chars (128 bit) of SHA-256(endpoint).
// Hex is safe as a Firebase key and matches the Worker's /^[A-Za-z0-9_-]{1,128}$/.
export async function endpointHash(endpoint) {
  const data = new TextEncoder().encode(String(endpoint));
  const digest = await globalThis.crypto.subtle.digest('SHA-256', data);
  return Array.from(new Uint8Array(digest), b => b.toString(16).padStart(2, '0')).join('').slice(0, 32);
}

// PushSubscription (or its toJSON()) -> the record stored in the database; null if it is incomplete.
export function subscriptionRecord(sub, now = Date.now()) {
  const j = sub && typeof sub.toJSON === 'function' ? sub.toJSON() : sub;
  if (!j || typeof j.endpoint !== 'string' || !j.keys || !j.keys.p256dh || !j.keys.auth) return null;
  return { endpoint: j.endpoint, keys: { p256dh: j.keys.p256dh, auth: j.keys.auth }, ts: now };
}

// iPhone/iPad Safari only supports web push for an installed Home Screen app. True when we are on iOS/iPadOS
// and NOT running standalone (so the right hint is "add to Home Screen", not an enable button).
export function iosNeedsHomeScreen({ userAgent = '', platform = '', maxTouchPoints = 0, standalone = false, displayStandalone = false } = {}) {
  const iPadOnMac = platform === 'MacIntel' && maxTouchPoints > 1; // iPadOS 13+ reports a Mac UA
  const ios = /iPhone|iPad|iPod/.test(userAgent) || iPadOnMac;
  return ios && !standalone && !displayStandalone;
}

// Fire-and-forget call to the Worker. Never throws and never blocks the app: resolves to
// 'skipped' (not configured / local backend / nothing to send), 'sent' or 'failed' (only logged).
export async function notifyWorker({
  pushUrl, backendKind, eventId, getIdToken, fetchFn = globalThis.fetch, timeoutMs = 8000, warn = console.warn
} = {}) {
  const base = String(pushUrl || '').trim().replace(/\/+$/, '');
  if (!base || backendKind !== 'firebase' || !eventId || typeof fetchFn !== 'function' || typeof getIdToken !== 'function') return 'skipped';
  const ctrl = typeof AbortController !== 'undefined' ? new AbortController() : null;
  const timer = ctrl ? setTimeout(() => ctrl.abort(), timeoutMs) : null;
  try {
    const token = await getIdToken();
    if (!token) return 'skipped';
    const res = await fetchFn(`${base}/notify`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ eventId }),
      signal: ctrl ? ctrl.signal : undefined
    });
    if (!res.ok) { warn(`Push notify failed: HTTP ${res.status}`); return 'failed'; }
    return 'sent';
  } catch (e) {
    warn('Push notify failed:', e && e.name === 'AbortError' ? 'timed out' : e);
    return 'failed';
  } finally {
    if (timer) clearTimeout(timer);
  }
}

// Asks the Worker to send a test push: target 'self' (this person's devices), 'other', or 'reminder' (this person's daily
// run reminder with today's recommendation; the Worker may answer `rest: true` / reason 'no-run' when there is no run today,
// the message then says so). Injectable, never throws.
// -> { ok, sent, rest?, reason?, status? }. ok = the Worker answered 2xx. reason: 'no-subscription' | 'not-delivered' (2xx, sent 0)
// | 'rate-limited' (429) | 'http' (other status) | 'network' (unreachable / timeout) | 'not-configured' | 'bad-target'.
export async function sendTestPush(target, { fetch: fetchFn = globalThis.fetch, getToken, url, timeoutMs = 8000 } = {}) {
  const base = String(url || '').trim().replace(/\/+$/, '');
  if (target !== 'self' && target !== 'other' && target !== 'reminder') return { ok: false, sent: 0, reason: 'bad-target' };
  if (!base || typeof fetchFn !== 'function' || typeof getToken !== 'function') return { ok: false, sent: 0, reason: 'not-configured' };
  const ctrl = typeof AbortController !== 'undefined' ? new AbortController() : null;
  const timer = ctrl ? setTimeout(() => ctrl.abort(), timeoutMs) : null;
  try {
    const token = await getToken();
    if (!token) return { ok: false, sent: 0, reason: 'not-configured' };
    const res = await fetchFn(`${base}/notify`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ test: target }),
      signal: ctrl ? ctrl.signal : undefined
    });
    if (res.status === 429) return { ok: false, sent: 0, status: 429, reason: 'rate-limited' };
    if (!res.ok) return { ok: false, sent: 0, status: res.status, reason: 'http' };
    let data = null;
    try { data = await res.json(); } catch (e) { /* treated as sent 0 below */ }
    const sent = data && Number.isFinite(data.sent) ? data.sent : 0;
    const rest = target === 'reminder' && !!data && (data.rest === true || data.reason === 'no-run');
    if (sent > 0) return rest ? { ok: true, sent, rest: true, status: res.status } : { ok: true, sent, status: res.status };
    if (rest) return { ok: true, sent: 0, rest: true, status: res.status, reason: 'no-run' };
    return { ok: true, sent: 0, status: res.status, reason: data && data.reason === 'no-subscription' ? 'no-subscription' : 'not-delivered' };
  } catch (e) {
    return { ok: false, sent: 0, reason: 'network' };
  } finally {
    if (timer) clearTimeout(timer);
  }
}

// sendTestPush result -> { kind: 'success'|'warning'|'error', message } for the Settings banner.
export function testPushMessage(r, target = 'self') {
  if (target === 'reminder') {
    if (r && r.ok && r.rest) return { kind: 'info', message: 'Today there is no run to recommend (rest day) \u2014 the test message says so' };
    if (r && r.ok && r.sent > 0) return { kind: 'success', message: `Reminder sent to ${r.sent} ${r.sent === 1 ? 'device' : 'devices'} \u2014 it should arrive within a few seconds` };
  }
  if (r && r.ok && r.sent > 0) return { kind: 'success', message: `Sent to ${r.sent} ${r.sent === 1 ? 'device' : 'devices'} \u2014 it should arrive within a few seconds` };
  const reason = r && r.reason;
  if (reason === 'no-subscription') {
    return { kind: 'warning', message: target === 'self' || target === 'reminder' ? 'No device registered yet \u2014 tap Enable alerts on this device first' : 'No device registered yet \u2014 tap Enable alerts on that phone first' };
  }
  if (reason === 'not-delivered') return { kind: 'warning', message: 'The push service did not accept the message. Try again, or turn alerts off and on again on the receiving device' };
  if (reason === 'rate-limited') return { kind: 'warning', message: 'Too many tests, wait a few seconds' };
  if (reason === 'http') return { kind: 'error', message: `The notification service answered with an error (HTTP ${r.status})` };
  return { kind: 'error', message: 'Could not reach the notification service' };
}

/* ---------- browser side ---------- */

export function isPushSupported() {
  return typeof navigator !== 'undefined' && typeof window !== 'undefined' &&
    'serviceWorker' in navigator && 'PushManager' in window && typeof Notification !== 'undefined';
}

export function needsHomeScreen() {
  if (typeof navigator === 'undefined') return false;
  let displayStandalone = false;
  try { displayStandalone = !!(window.matchMedia && window.matchMedia('(display-mode: standalone)').matches); } catch (e) { /* ignore */ }
  return iosNeedsHomeScreen({
    userAgent: navigator.userAgent, platform: navigator.platform, maxTouchPoints: navigator.maxTouchPoints,
    standalone: navigator.standalone === true, displayStandalone
  });
}

async function registration() {
  // `ready` never resolves when no worker is registered (http, failed registration): give up after a few seconds.
  return Promise.race([
    navigator.serviceWorker.ready,
    new Promise((_, rej) => setTimeout(() => rej(new Error('The service worker is not ready (needs https).')), 8000))
  ]);
}

export async function currentSubscription() {
  if (!isPushSupported()) return null;
  try { return await (await registration()).pushManager.getSubscription(); } catch (e) { return null; }
}

// Needs notification permission to be granted already. Reuses an existing subscription for the same key.
export async function subscribeToPush(vapidPublicKey) {
  if (!isPushSupported()) throw new Error('Push is not supported in this browser.');
  if (!vapidPublicKey) throw new Error('Push is not configured (missing VAPID public key).');
  const reg = await registration();
  const key = urlBase64ToUint8Array(vapidPublicKey);
  const existing = await reg.pushManager.getSubscription();
  if (existing) {
    const old = existing.options && existing.options.applicationServerKey;
    // A subscription made with a different (rotated) VAPID key can never receive our pushes: replace it.
    if (!old || uint8ToUrlBase64(old) === uint8ToUrlBase64(key)) return existing;
    try { await existing.unsubscribe(); } catch (e) { /* ignore */ }
  }
  return reg.pushManager.subscribe({ userVisibleOnly: true, applicationServerKey: key });
}

// Resolves to the endpoint that was removed (or null if there was no subscription).
export async function unsubscribeFromPush() {
  const sub = await currentSubscription();
  if (!sub) return null;
  const endpoint = sub.endpoint;
  try { await sub.unsubscribe(); } catch (e) { /* already gone */ }
  return endpoint;
}
