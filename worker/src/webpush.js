// Web Push for Workers, written directly on WebCrypto:
//  - RFC 8291 message encryption (aes128gcm content coding, RFC 8188)
//  - RFC 8292 VAPID (ES256 JWT)
// No dependencies, so there is nothing to keep patched and the interop is covered by tests/webpush.test.js.
import { b64urlDecode, b64urlEncode, concat, utf8 } from './encoding.js';

const RECORD_SIZE = 4096;
const MAX_PLAINTEXT = RECORD_SIZE - 16 - 1 - 86; // tag + delimiter + header overhead; push services accept ~4 KB

async function hkdf(salt, ikm, info, bytes) {
  const key = await crypto.subtle.importKey('raw', ikm, 'HKDF', false, ['deriveBits']);
  return new Uint8Array(await crypto.subtle.deriveBits({ name: 'HKDF', hash: 'SHA-256', salt, info }, key, bytes * 8));
}

// subscription keys: { p256dh: base64url(65 byte uncompressed point), auth: base64url(16 bytes) }
// -> Uint8Array request body. `opts.salt` / `opts.ephemeral` exist for deterministic tests only.
export async function encryptPayload(plaintext, keys, opts = {}) {
  const uaPublic = b64urlDecode(keys.p256dh);
  const authSecret = b64urlDecode(keys.auth);
  if (uaPublic.length !== 65 || uaPublic[0] !== 4) throw new Error('bad p256dh key');
  if (authSecret.length !== 16) throw new Error('bad auth secret');
  const data = typeof plaintext === 'string' ? utf8(plaintext) : plaintext;
  if (data.length > MAX_PLAINTEXT) throw new Error('payload too large');

  const eph = opts.ephemeral || await crypto.subtle.generateKey({ name: 'ECDH', namedCurve: 'P-256' }, true, ['deriveBits']);
  const asPublic = new Uint8Array(await crypto.subtle.exportKey('raw', eph.publicKey));
  const uaKey = await crypto.subtle.importKey('raw', uaPublic, { name: 'ECDH', namedCurve: 'P-256' }, false, []);
  const ecdh = new Uint8Array(await crypto.subtle.deriveBits({ name: 'ECDH', public: uaKey }, eph.privateKey, 256));

  const ikm = await hkdf(authSecret, ecdh, concat(utf8('WebPush: info\0'), uaPublic, asPublic), 32);
  const salt = opts.salt || crypto.getRandomValues(new Uint8Array(16));
  const cek = await hkdf(salt, ikm, utf8('Content-Encoding: aes128gcm\0'), 16);
  const nonce = await hkdf(salt, ikm, utf8('Content-Encoding: nonce\0'), 12);

  const aes = await crypto.subtle.importKey('raw', cek, 'AES-GCM', false, ['encrypt']);
  const ct = new Uint8Array(await crypto.subtle.encrypt({ name: 'AES-GCM', iv: nonce }, aes, concat(data, new Uint8Array([2]))));
  const header = new Uint8Array(21);
  header.set(salt, 0);
  new DataView(header.buffer).setUint32(16, RECORD_SIZE);
  header[20] = asPublic.length;
  return concat(header, asPublic, ct);
}

// Imports the VAPID key pair from base64url (private = raw d, public = uncompressed point).
export async function importVapidPrivateKey(privateB64, publicB64) {
  const pub = b64urlDecode(publicB64);
  if (pub.length !== 65 || pub[0] !== 4) throw new Error('VAPID_PUBLIC_KEY must be a base64url uncompressed P-256 point');
  const d = b64urlDecode(privateB64);
  if (d.length !== 32) throw new Error('VAPID_PRIVATE_KEY must be 32 base64url bytes');
  return crypto.subtle.importKey('jwk', {
    kty: 'EC', crv: 'P-256', d: b64urlEncode(d), x: b64urlEncode(pub.slice(1, 33)), y: b64urlEncode(pub.slice(33, 65))
  }, { name: 'ECDSA', namedCurve: 'P-256' }, false, ['sign']);
}

// -> Authorization header value `vapid t=<jwt>, k=<public key>`.
export async function vapidAuthorization(endpoint, { subject, publicKey, privateKey, now = Date.now }) {
  const aud = new URL(endpoint).origin;
  const head = b64urlEncode(utf8(JSON.stringify({ typ: 'JWT', alg: 'ES256' })));
  const body = b64urlEncode(utf8(JSON.stringify({ aud, exp: Math.floor(now() / 1000) + 12 * 3600, sub: subject })));
  const key = typeof privateKey === 'string' ? await importVapidPrivateKey(privateKey, publicKey) : privateKey;
  const sig = new Uint8Array(await crypto.subtle.sign({ name: 'ECDSA', hash: 'SHA-256' }, key, utf8(head + '.' + body)));
  return `vapid t=${head}.${body}.${b64urlEncode(sig)}, k=${publicKey}`;
}

// Sends one push. -> { status, ok, gone } (gone = subscription expired: 404/410).
export async function sendWebPush(sub, payload, { fetchFn = fetch, subject, publicKey, privateKey, now = Date.now, ttl = 3600, urgency = 'normal' }) {
  const url = new URL(sub.endpoint);
  if (url.protocol !== 'https:') throw new Error('push endpoint must be https');
  const body = await encryptPayload(typeof payload === 'string' ? payload : JSON.stringify(payload), sub.keys);
  const res = await fetchFn(sub.endpoint, {
    method: 'POST',
    headers: {
      Authorization: await vapidAuthorization(sub.endpoint, { subject, publicKey, privateKey, now }),
      'Content-Encoding': 'aes128gcm',
      'Content-Type': 'application/octet-stream',
      TTL: String(ttl),
      Urgency: urgency
    },
    body
  });
  try { await res.arrayBuffer(); } catch { /* drain */ }
  return { status: res.status, ok: res.status >= 200 && res.status < 300, gone: res.status === 404 || res.status === 410 };
}
