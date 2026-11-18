// Full verification of a Firebase Auth ID token inside the Worker (RS256 via WebCrypto).
import { b64urlDecode, utf8 } from './encoding.js';
import { importRsaVerifyKey } from './x509.js';

export const CERTS_URL = 'https://www.googleapis.com/robot/v1/metadata/x509/securetoken@system.gserviceaccount.com';
const LEEWAY_S = 60;

export class AuthError extends Error {
  constructor(message, status = 401) { super(message); this.status = status; }
}

// Returns async getCerts({force}) -> { [kid]: pemString }. Caches in memory for the response's max-age.
// A forced refresh (unknown kid, i.e. Google rotated keys) is throttled to once a minute.
export function createCertSource(fetchFn, now = Date.now) {
  let certs = null, expires = 0, lastForce = 0, inflight = null;
  return async function getCerts({ force = false } = {}) {
    const t = now();
    if (certs && t < expires && !(force && t - lastForce > 60000)) return certs;
    if (force) lastForce = t;
    if (!inflight) {
      inflight = (async () => {
        const res = await fetchFn(CERTS_URL);
        if (!res.ok) throw new AuthError('could not load signing certificates', 503);
        const maxAge = /max-age=(\d+)/.exec(res.headers.get('cache-control') || '');
        certs = await res.json();
        expires = now() + (maxAge ? Number(maxAge[1]) : 3600) * 1000;
        return certs;
      })().finally(() => { inflight = null; });
    }
    return inflight;
  };
}

function parseJson(bytes, what) {
  try { return JSON.parse(new TextDecoder().decode(bytes)); } catch { throw new AuthError(`malformed token ${what}`); }
}

const keyCache = new Map(); // pem -> CryptoKey
async function keyFor(pem) {
  if (!keyCache.has(pem)) {
    if (keyCache.size > 20) keyCache.clear();
    keyCache.set(pem, importRsaVerifyKey(pem));
  }
  return keyCache.get(pem);
}

// -> { uid, email, person: 'a'|'b', claims }; throws AuthError (401 bad token, 403 not allowlisted).
export async function verifyFirebaseIdToken(token, { projectId, personAEmail, personBEmail, getCerts, now = Date.now }) {
  if (typeof token !== 'string' || token.length > 4096) throw new AuthError('missing or oversized token');
  const parts = token.split('.');
  if (parts.length !== 3) throw new AuthError('malformed token');
  let header, claims, sig;
  try {
    header = parseJson(b64urlDecode(parts[0]), 'header');
    claims = parseJson(b64urlDecode(parts[1]), 'payload');
    sig = b64urlDecode(parts[2]);
  } catch (e) { throw e instanceof AuthError ? e : new AuthError('malformed token'); }
  if (!header || header.alg !== 'RS256' || typeof header.kid !== 'string') throw new AuthError('unsupported token algorithm');
  if (!claims || typeof claims !== 'object') throw new AuthError('malformed token payload');

  let certs = await getCerts({ force: false });
  if (!certs[header.kid]) certs = await getCerts({ force: true });
  const pem = certs[header.kid];
  if (!pem) throw new AuthError('unknown signing key');
  let ok = false;
  try {
    ok = await crypto.subtle.verify('RSASSA-PKCS1-v1_5', await keyFor(pem), sig, utf8(parts[0] + '.' + parts[1]));
  } catch { ok = false; }
  if (!ok) throw new AuthError('bad token signature');

  const nowS = Math.floor(now() / 1000);
  const num = v => typeof v === 'number' && Number.isFinite(v);
  if (claims.iss !== `https://securetoken.google.com/${projectId}`) throw new AuthError('wrong token issuer');
  if (claims.aud !== projectId) throw new AuthError('wrong token audience');
  if (!num(claims.exp) || claims.exp <= nowS) throw new AuthError('token expired');
  if (!num(claims.iat) || claims.iat > nowS + LEEWAY_S) throw new AuthError('token issued in the future');
  if (!num(claims.auth_time) || claims.auth_time > nowS + LEEWAY_S) throw new AuthError('bad auth_time');
  if (typeof claims.sub !== 'string' || !claims.sub || claims.sub.length > 128) throw new AuthError('missing subject');
  if (claims.email_verified !== true) throw new AuthError('email not verified', 403);
  const email = String(claims.email || '').trim().toLowerCase();
  const a = String(personAEmail || '').trim().toLowerCase();
  const b = String(personBEmail || '').trim().toLowerCase();
  const person = email && email === a ? 'a' : email && email === b ? 'b' : null;
  if (!person) throw new AuthError('account not allowed', 403);
  return { uid: claims.sub, email, person, claims };
}
