import { test } from 'node:test';
import assert from 'node:assert/strict';
import { generateKeyPairSync, createVerify } from 'node:crypto';
import { parseServiceAccount, createAssertion, createTokenSource, TOKEN_URL, SCOPE } from '../src/serviceAccount.js';

const { privateKey, publicKey } = generateKeyPairSync('rsa', { modulusLength: 2048 });
const PEM = privateKey.export({ type: 'pkcs8', format: 'pem' });
const KEY_FILE = { type: 'service_account', project_id: 'p', client_email: 'sa@p.iam.gserviceaccount.com', private_key: PEM, token_uri: 'https://evil.example/token' };
const dec = s => JSON.parse(Buffer.from(s, 'base64url').toString());

test('parseServiceAccount: accepts the key file JSON (string or object), rejects everything else', () => {
  const a = parseServiceAccount(JSON.stringify(KEY_FILE));
  assert.equal(a.clientEmail, KEY_FILE.client_email);
  assert.equal(a.privateKeyPem, PEM);
  assert.ok(parseServiceAccount(KEY_FILE));
  for (const bad of [undefined, null, '', '  ', '{nope', '[]', '{}', 5, JSON.stringify({ client_email: 'x@y', private_key: 'nope' }),
    JSON.stringify({ client_email: 'nomail', private_key: PEM }), JSON.stringify({ private_key: PEM })]) {
    assert.equal(parseServiceAccount(bad), null, String(bad));
  }
});

test('createAssertion: RS256 JWT with the right claims, verifiable with the public key', async () => {
  const now = Date.UTC(2026, 2, 3, 6, 0, 0);
  const jwt = await createAssertion(parseServiceAccount(KEY_FILE), now);
  const [h, p, s] = jwt.split('.');
  assert.deepEqual(dec(h), { alg: 'RS256', typ: 'JWT' });
  assert.deepEqual(dec(p), { iss: KEY_FILE.client_email, scope: SCOPE, aud: TOKEN_URL, iat: now / 1000, exp: now / 1000 + 3600 });
  assert.match(dec(p).scope, /firebase\.database/); assert.match(dec(p).scope, /userinfo\.email/);
  assert.ok(createVerify('RSA-SHA256').update(`${h}.${p}`).verify(publicKey, Buffer.from(s, 'base64url')));
  assert.ok(!createVerify('RSA-SHA256').update(`${h}.${p}x`).verify(publicKey, Buffer.from(s, 'base64url')));
});

function oauth({ expiresIn = 3600, status = 200, body } = {}) {
  const calls = [];
  let n = 0;
  const fetchFn = async (url, init) => {
    calls.push({ url, init });
    if (status !== 200) return new Response('nope', { status });
    return Response.json(body ?? { access_token: `tok${++n}`, expires_in: expiresIn, token_type: 'Bearer' });
  };
  return { fetchFn, calls };
}

test('token source: POSTs the JWT-bearer grant to Google (never to token_uri of the file), form encoded', async () => {
  const o = oauth();
  const getToken = createTokenSource({ account: parseServiceAccount(KEY_FILE), fetchFn: o.fetchFn, now: () => 1_000_000 });
  assert.equal(await getToken(), 'tok1');
  assert.equal(o.calls.length, 1);
  assert.equal(o.calls[0].url, 'https://oauth2.googleapis.com/token');
  assert.equal(o.calls[0].init.method, 'POST');
  assert.equal(o.calls[0].init.headers['Content-Type'], 'application/x-www-form-urlencoded');
  const form = new URLSearchParams(o.calls[0].init.body);
  assert.equal(form.get('grant_type'), 'urn:ietf:params:oauth:grant-type:jwt-bearer');
  const [h, p, s] = form.get('assertion').split('.');
  assert.ok(createVerify('RSA-SHA256').update(`${h}.${p}`).verify(publicKey, Buffer.from(s, 'base64url')));
  assert.equal(dec(p).iat, 1000);
});

test('token source: cached until 60 s before expiry, then refreshed; concurrent callers share one request', async () => {
  const o = oauth({ expiresIn: 3600 });
  let t = 0;
  const getToken = createTokenSource({ account: parseServiceAccount(KEY_FILE), fetchFn: o.fetchFn, now: () => t });
  const [x, y] = await Promise.all([getToken(), getToken()]);
  assert.equal(x, 'tok1'); assert.equal(y, 'tok1'); assert.equal(o.calls.length, 1);
  t = 3539_000; assert.equal(await getToken(), 'tok1', 'still valid 61 s before expiry');
  t = 3540_000; assert.equal(await getToken(), 'tok2', 'refreshed at expiry - 60 s');
  assert.equal(o.calls.length, 2);
  t = 3540_000 + 100_000; assert.equal(await getToken(), 'tok2');
  assert.equal(o.calls.length, 2);
});

test('token source: short-lived tokens are refreshed immediately; errors reject and the next call retries', async () => {
  const o = oauth({ expiresIn: 30 });
  const getToken = createTokenSource({ account: parseServiceAccount(KEY_FILE), fetchFn: o.fetchFn, now: () => 0 });
  assert.equal(await getToken(), 'tok1'); assert.equal(await getToken(), 'tok2');

  for (const o2 of [oauth({ status: 400 }), oauth({ body: { nope: 1 } })]) {
    const g = createTokenSource({ account: parseServiceAccount(KEY_FILE), fetchFn: o2.fetchFn, now: () => 0 });
    await assert.rejects(g());
    await assert.rejects(g());
    assert.equal(o2.calls.length, 2, 'a failure is not cached');
  }
});

test('token source: an unusable private key rejects (no token, no request)', async () => {
  const o = oauth();
  const bad = { clientEmail: 'sa@p.iam.gserviceaccount.com', privateKeyPem: '-----BEGIN PRIVATE KEY-----\nAAAA\n-----END PRIVATE KEY-----' };
  await assert.rejects(createTokenSource({ account: bad, fetchFn: o.fetchFn, now: () => 0 })());
  assert.equal(o.calls.length, 0);
});
