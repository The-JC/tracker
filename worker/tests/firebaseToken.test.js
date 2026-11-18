import { test } from 'node:test';
import assert from 'node:assert/strict';
import { generateKeyPairSync } from 'node:crypto';
import { verifyFirebaseIdToken, createCertSource, CERTS_URL } from '../src/firebaseToken.js';
import { spkiFromPem } from '../src/x509.js';
import { ENV, PROJECT, makeIssuer, fakeCertPem } from './helpers.js';

const opts = iss => ({ projectId: PROJECT, personAEmail: ENV.PERSON_A_EMAIL, personBEmail: ENV.PERSON_B_EMAIL, getCerts: iss.getCerts });
const rejects = (p, status, re) => assert.rejects(p, e => e.status === status && (!re || re.test(e.message)));

test('x509: extracts the exact SPKI from the certificate', () => {
  const { publicKey } = generateKeyPairSync('rsa', { modulusLength: 2048 });
  const spki = publicKey.export({ type: 'spki', format: 'der' });
  assert.deepEqual(Buffer.from(spkiFromPem(fakeCertPem(spki))), spki);
});

test('valid token resolves to person a, email compare is case-insensitive', async () => {
  const iss = makeIssuer();
  const a = await verifyFirebaseIdToken(iss.mint(), opts(iss));
  assert.equal(a.person, 'a'); assert.equal(a.uid, 'uid-1');
  const b = await verifyFirebaseIdToken(iss.mint({ email: 'person-b@EXAMPLE.test' }), opts(iss));
  assert.equal(b.person, 'b');
});

test('rejects: signature, alg, kid, iss, aud, exp, iat, auth_time, sub, verified, allowlist', async () => {
  const iss = makeIssuer(), other = makeIssuer();
  const t = (c, h) => verifyFirebaseIdToken(iss.mint(c, h), opts(iss));
  await rejects(verifyFirebaseIdToken(other.mint(), opts(iss)), 401, /signature/);
  const parts = iss.mint().split('.');
  await rejects(verifyFirebaseIdToken(parts[0] + '.' + Buffer.from(JSON.stringify({ ...JSON.parse(Buffer.from(parts[1], 'base64url')), email: 'person-b@example.test' })).toString('base64url') + '.' + parts[2], opts(iss)), 401, /signature/);
  await rejects(t({}, { header: { alg: 'none' } }), 401, /algorithm/);
  await rejects(t({}, { header: { kid: 'nope' } }), 401, /unknown signing key/);
  await rejects(t({ iss: 'https://securetoken.google.com/other' }), 401, /issuer/);
  await rejects(t({ aud: 'other' }), 401, /audience/);
  await rejects(t({ exp: Math.floor(Date.now() / 1000) - 5 }), 401, /expired/);
  await rejects(t({ iat: Math.floor(Date.now() / 1000) + 600 }), 401, /future/);
  await rejects(t({ auth_time: Math.floor(Date.now() / 1000) + 600 }), 401, /auth_time/);
  await rejects(t({ auth_time: undefined }), 401, /auth_time/);
  await rejects(t({ sub: '' }), 401, /subject/);
  await rejects(t({ email_verified: false }), 403, /verified/);
  await rejects(t({ email: 'mallory@example.test' }), 403, /not allowed/);
  await rejects(t({ email: undefined }), 403, /not allowed/);
  await rejects(verifyFirebaseIdToken('a.b', opts(iss)), 401);
  await rejects(verifyFirebaseIdToken('', opts(iss)), 401);
});

test('cert source caches by max-age and refreshes on expiry', async () => {
  let calls = 0, clock = 1_000_000;
  const f = async url => {
    calls++; assert.equal(url, CERTS_URL);
    return new Response(JSON.stringify({ k: 'pem' }), { headers: { 'cache-control': 'public, max-age=100, must-revalidate' } });
  };
  const get = createCertSource(f, () => clock);
  await get(); await get(); assert.equal(calls, 1);
  clock += 101_000; await get(); assert.equal(calls, 2);
  clock += 1000; await get({ force: true }); assert.equal(calls, 3);
  await get({ force: true }); assert.equal(calls, 3, 'forced refresh is throttled to once a minute');
});

test('unknown kid triggers one forced cert refresh (key rotation)', async () => {
  const iss = makeIssuer('new');
  let forced = 0;
  const getCerts = async ({ force } = {}) => { if (force) forced++; return force ? { new: iss.pem } : {}; };
  const r = await verifyFirebaseIdToken(iss.mint(), { ...opts(iss), getCerts });
  assert.equal(r.person, 'a'); assert.equal(forced, 1);
});
