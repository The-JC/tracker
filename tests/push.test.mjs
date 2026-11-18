import test from 'node:test';
import assert from 'node:assert/strict';
import {
  urlBase64ToUint8Array, uint8ToUrlBase64, endpointHash, subscriptionRecord, iosNeedsHomeScreen, notifyWorker
} from '../src/push.js';
import { shouldShowSystemNotification } from '../src/notifications.js';

test('base64url <-> Uint8Array round trip, with and without padding', () => {
  // 65-byte uncompressed P-256 point shape (0x04 prefix) with url-unsafe characters in the encoding
  const bytes = Uint8Array.from({ length: 65 }, (_, i) => (i === 0 ? 4 : (i * 37 + 250) % 256));
  const b64 = uint8ToUrlBase64(bytes);
  assert.ok(!/[+/=]/.test(b64));
  assert.deepEqual(urlBase64ToUint8Array(b64), bytes);
  assert.deepEqual(urlBase64ToUint8Array(b64 + '=='.slice(0, (4 - (b64.length % 4)) % 4)), bytes, 'padded input accepted');
  assert.deepEqual([...urlBase64ToUint8Array('_-8')], [0xff, 0xef]);
  assert.deepEqual([...urlBase64ToUint8Array('SGk')], [72, 105]);
  assert.equal(urlBase64ToUint8Array('').length, 0);
});

test('endpointHash is stable, hex, 32 chars, and distinguishes endpoints', async () => {
  const a = 'https://fcm.googleapis.com/fcm/send/abc:123';
  assert.equal(await endpointHash(a), await endpointHash(a));
  assert.match(await endpointHash(a), /^[0-9a-f]{32}$/);
  assert.notEqual(await endpointHash(a), await endpointHash(a + 'x'));
  // known SHA-256("abc") prefix
  assert.equal(await endpointHash('abc'), 'ba7816bf8f01cfea414140de5dae2223');
});

test('subscriptionRecord accepts toJSON() shapes and rejects incomplete ones', () => {
  const json = { endpoint: 'https://x/y', expirationTime: null, keys: { p256dh: 'P', auth: 'A' } };
  assert.deepEqual(subscriptionRecord({ toJSON: () => json }, 5), { endpoint: 'https://x/y', keys: { p256dh: 'P', auth: 'A' }, ts: 5 });
  assert.deepEqual(subscriptionRecord(json, 6).ts, 6);
  assert.equal(subscriptionRecord({ endpoint: 'https://x/y' }), null);
  assert.equal(subscriptionRecord(null), null);
});

test('iosNeedsHomeScreen: only iOS/iPadOS outside the installed app', () => {
  const iphone = { userAgent: 'Mozilla/5.0 (iPhone; CPU iPhone OS 17_0 like Mac OS X)', platform: 'iPhone', maxTouchPoints: 5 };
  assert.equal(iosNeedsHomeScreen(iphone), true);
  assert.equal(iosNeedsHomeScreen({ ...iphone, standalone: true }), false);
  assert.equal(iosNeedsHomeScreen({ ...iphone, displayStandalone: true }), false);
  assert.equal(iosNeedsHomeScreen({ userAgent: 'Macintosh', platform: 'MacIntel', maxTouchPoints: 5 }), true, 'iPadOS pretends to be a Mac');
  assert.equal(iosNeedsHomeScreen({ userAgent: 'Macintosh', platform: 'MacIntel', maxTouchPoints: 0 }), false, 'real Mac');
  assert.equal(iosNeedsHomeScreen({ userAgent: 'Mozilla/5.0 (Linux; Android 14)', platform: 'Linux armv8l', maxTouchPoints: 5 }), false);
  assert.equal(iosNeedsHomeScreen(), false);
});

/* ---------- notifyWorker ---------- */

const quiet = () => {};
const ok = { ok: true, status: 200 };
const base = { pushUrl: 'https://w.example.dev', backendKind: 'firebase', eventId: '-Nabc', getIdToken: async () => 'TOK', warn: quiet };

test('notifyWorker skips without URL, with the local backend, without event id or token', async () => {
  let calls = 0;
  const fetchFn = async () => { calls++; return ok; };
  assert.equal(await notifyWorker({ ...base, fetchFn, pushUrl: '' }), 'skipped');
  assert.equal(await notifyWorker({ ...base, fetchFn, pushUrl: undefined }), 'skipped');
  assert.equal(await notifyWorker({ ...base, fetchFn, backendKind: 'local' }), 'skipped');
  assert.equal(await notifyWorker({ ...base, fetchFn, eventId: '' }), 'skipped');
  assert.equal(await notifyWorker({ ...base, fetchFn, getIdToken: async () => null }), 'skipped');
  assert.equal(await notifyWorker({ ...base, fetchFn: undefined, getIdToken: undefined }), 'skipped');
  assert.equal(calls, 0);
});

test('notifyWorker builds the documented request', async () => {
  let seen;
  const fetchFn = async (url, init) => { seen = { url, init }; return ok; };
  assert.equal(await notifyWorker({ ...base, fetchFn, pushUrl: 'https://w.example.dev//' }), 'sent');
  assert.equal(seen.url, 'https://w.example.dev/notify');
  assert.equal(seen.init.method, 'POST');
  assert.equal(seen.init.headers.Authorization, 'Bearer TOK');
  assert.equal(seen.init.headers['Content-Type'], 'application/json');
  assert.deepEqual(JSON.parse(seen.init.body), { eventId: '-Nabc' });
  assert.ok(seen.init.signal, 'abortable');
});

test('notifyWorker never throws: HTTP errors, network errors, token errors, timeouts only warn', async () => {
  const warns = [];
  const warn = (...a) => warns.push(a);
  assert.equal(await notifyWorker({ ...base, warn, fetchFn: async () => ({ ok: false, status: 401 }) }), 'failed');
  assert.equal(await notifyWorker({ ...base, warn, fetchFn: async () => { throw new Error('offline'); } }), 'failed');
  assert.equal(await notifyWorker({ ...base, warn, fetchFn: async () => ok, getIdToken: async () => { throw new Error('no auth'); } }), 'failed');
  const hang = (_u, { signal }) => new Promise((_, rej) => signal.addEventListener('abort', () => rej(Object.assign(new Error('aborted'), { name: 'AbortError' }))));
  assert.equal(await notifyWorker({ ...base, warn, fetchFn: hang, timeoutMs: 20 }), 'failed');
  assert.equal(warns.length, 4);
});

test('system notification is skipped locally when real push is active', () => {
  assert.equal(shouldShowSystemNotification({ permission: 'granted', hidden: true, pushActive: true }), false);
  assert.equal(shouldShowSystemNotification({ permission: 'granted', hidden: true, pushActive: false }), true);
});
