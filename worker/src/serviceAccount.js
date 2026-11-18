// Google service account -> OAuth2 access token for the Realtime Database REST API (JWT bearer flow, RFC 7523),
// on WebCrypto only. The cron has no signed-in user, so this is how it gets database access.
// Everything is injected (fetchFn, now, subtle) so it is testable without network.
import { b64urlEncode, utf8 } from './encoding.js';

export const TOKEN_URL = 'https://oauth2.googleapis.com/token';
export const SCOPE = 'https://www.googleapis.com/auth/firebase.database https://www.googleapis.com/auth/userinfo.email';
const REFRESH_MARGIN_MS = 60 * 1000;
const LIFETIME_S = 3600;

// The secret holds the JSON key file. -> { clientEmail, privateKeyPem } or null when missing / malformed.
export function parseServiceAccount(raw) {
  let o = raw;
  if (typeof raw === 'string') {
    if (!raw.trim()) return null;
    try { o = JSON.parse(raw); } catch { return null; }
  }
  if (!o || typeof o !== 'object') return null;
  const email = o.client_email, pem = o.private_key;
  if (typeof email !== 'string' || !email.includes('@')) return null;
  if (typeof pem !== 'string' || !/-----BEGIN PRIVATE KEY-----[\s\S]+-----END PRIVATE KEY-----/.test(pem)) return null;
  return { clientEmail: email, privateKeyPem: pem };
}

function pemToDer(pem) {
  const b64 = pem.replace(/-----(BEGIN|END) PRIVATE KEY-----/g, '').replace(/\s+/g, '');
  const bin = atob(b64);
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return out;
}

// -> compact RS256 JWT assertion
export async function createAssertion({ clientEmail, privateKeyPem }, nowMs, subtle = crypto.subtle) {
  const key = await subtle.importKey('pkcs8', pemToDer(privateKeyPem), { name: 'RSASSA-PKCS1-v1_5', hash: 'SHA-256' }, false, ['sign']);
  const iat = Math.floor(nowMs / 1000);
  const head = b64urlEncode(utf8(JSON.stringify({ alg: 'RS256', typ: 'JWT' })));
  const body = b64urlEncode(utf8(JSON.stringify({ iss: clientEmail, scope: SCOPE, aud: TOKEN_URL, iat, exp: iat + LIFETIME_S })));
  const sig = new Uint8Array(await subtle.sign('RSASSA-PKCS1-v1_5', key, utf8(`${head}.${body}`)));
  return `${head}.${body}.${b64urlEncode(sig)}`;
}

// -> async getToken() returning a cached access token until ~60 s before it expires (in isolate memory).
export function createTokenSource({ account, fetchFn, now = Date.now, subtle = crypto.subtle }) {
  let token = null, expiresAt = 0, inflight = null;
  return async function getToken() {
    if (token && now() < expiresAt - REFRESH_MARGIN_MS) return token;
    if (!inflight) {
      inflight = (async () => {
        const assertion = await createAssertion(account, now(), subtle);
        const res = await fetchFn(TOKEN_URL, {
          method: 'POST',
          headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
          body: new URLSearchParams({ grant_type: 'urn:ietf:params:oauth:grant-type:jwt-bearer', assertion }).toString()
        });
        if (!res.ok) { try { await res.arrayBuffer(); } catch { /* drain */ } throw new Error(`token endpoint answered ${res.status}`); }
        const j = await res.json();
        if (!j || typeof j.access_token !== 'string' || !j.access_token) throw new Error('token endpoint returned no access_token');
        const ttl = Number.isFinite(Number(j.expires_in)) && Number(j.expires_in) > 0 ? Number(j.expires_in) : LIFETIME_S;
        token = j.access_token; expiresAt = now() + ttl * 1000;
        return token;
      })().finally(() => { inflight = null; });
    }
    return inflight;
  };
}
