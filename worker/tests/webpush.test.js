import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createECDH, hkdfSync, createDecipheriv, createPublicKey, verify, randomBytes } from 'node:crypto';
import { encryptPayload, vapidAuthorization, sendWebPush } from '../src/webpush.js';

// Independent RFC 8291 receiver, written against node:crypto only (shares no code with src/).
function decryptAes128gcm(body, uaEcdh, authSecret) {
  const salt = body.subarray(0, 16);
  const rs = body.readUInt32BE(16);
  const idlen = body[20];
  const asPublic = body.subarray(21, 21 + idlen);
  const ct = body.subarray(21 + idlen);
  assert.ok(rs >= 18 && ct.length <= rs, 'single record');
  const secret = uaEcdh.computeSecret(asPublic);
  const uaPublic = uaEcdh.getPublicKey();
  const ikm = Buffer.from(hkdfSync('sha256', secret, authSecret, Buffer.concat([Buffer.from('WebPush: info\0'), uaPublic, asPublic]), 32));
  const cek = Buffer.from(hkdfSync('sha256', ikm, salt, 'Content-Encoding: aes128gcm\0', 16));
  const nonce = Buffer.from(hkdfSync('sha256', ikm, salt, 'Content-Encoding: nonce\0', 12));
  const d = createDecipheriv('aes-128-gcm', cek, nonce);
  d.setAuthTag(ct.subarray(ct.length - 16));
  const plain = Buffer.concat([d.update(ct.subarray(0, ct.length - 16)), d.final()]);
  assert.equal(plain[plain.length - 1], 2, 'last-record delimiter');
  return plain.subarray(0, plain.length - 1);
}

function receiver() {
  const ecdh = createECDH('prime256v1'); ecdh.generateKeys();
  const auth = randomBytes(16);
  return { ecdh, auth, keys: { p256dh: ecdh.getPublicKey().toString('base64url'), auth: auth.toString('base64url') } };
}

test('aes128gcm payload decrypts with an independent RFC 8291 implementation', async () => {
  const r = receiver();
  for (const msg of ['hi', JSON.stringify({ title: 'Trailhead', body: 'Julian logged an 8.2 km run 🏃', tag: 'x', url: '/' }), 'x'.repeat(3000)]) {
    const body = Buffer.from(await encryptPayload(msg, r.keys));
    assert.equal(decryptAes128gcm(body, r.ecdh, r.auth).toString('utf8'), msg);
  }
});

test('RFC 8291 appendix A test vector decrypts', () => {
  const body = Buffer.from('DGv6ra1nlYgDCS1FRnbzlwAAEABBBP4z9KsN6nGRTbVYI_c7VJSPQTBtkgcy27mlmlMoZIIgDll6e3vCYLocInmYWAmS6TlzAC8wEqKK6PBru3jl7A_yl95bQpu6cVPTpK4Mqgkf1CXztLVBSt2Ks3oZwbuwXPXLWyouBWLVWGNWQexSgSxsj_Qulcy4a-fN', 'base64url');
  const ecdh = createECDH('prime256v1');
  ecdh.setPrivateKey(Buffer.from('q1dXpw3UpT5VOmu_cf_v6ih07Aems3njxI-JWgLcM94', 'base64url'));
  const out = decryptAes128gcm(body, ecdh, Buffer.from('BTBZMqHH6r4Tts7J_aSIgg', 'base64url'));
  assert.equal(out.toString(), 'When I grow up, I want to be a watermelon');
});

test('sendWebPush: headers, VAPID JWT shape and signature, 410 flagged gone', async () => {
  const kp = await crypto.subtle.generateKey({ name: 'ECDSA', namedCurve: 'P-256' }, true, ['sign', 'verify']);
  const jwk = await crypto.subtle.exportKey('jwk', kp.privateKey);
  const pubRaw = Buffer.concat([Buffer.from([4]), Buffer.from(jwk.x, 'base64url'), Buffer.from(jwk.y, 'base64url')]);
  const publicKey = pubRaw.toString('base64url'), privateKey = jwk.d;
  const r = receiver();
  const NOW = 1_800_000_000_000;
  let seen;
  const fetchFn = async (url, init) => { seen = { url, init }; return new Response(null, { status: 201 }); };
  const res = await sendWebPush({ endpoint: 'https://push.example.test/send/abc', keys: r.keys }, JSON.stringify({ title: 'Trailhead', body: 'hello' }),
    { fetchFn, subject: 'mailto:a@b.test', publicKey, privateKey, now: () => NOW });
  assert.deepEqual([res.ok, res.gone], [true, false]);
  const h = seen.init.headers;
  assert.equal(h.TTL, '3600'); assert.equal(h.Urgency, 'normal'); assert.equal(h['Content-Encoding'], 'aes128gcm');
  assert.equal(JSON.parse(decryptAes128gcm(Buffer.from(seen.init.body), r.ecdh, r.auth)).body, 'hello');

  const m = /^vapid t=([\w-]+)\.([\w-]+)\.([\w-]+), k=([\w-]+)$/.exec(h.Authorization);
  assert.ok(m, 'Authorization shape'); assert.equal(m[4], publicKey);
  assert.deepEqual(JSON.parse(Buffer.from(m[1], 'base64url')), { typ: 'JWT', alg: 'ES256' });
  const claims = JSON.parse(Buffer.from(m[2], 'base64url'));
  assert.equal(claims.aud, 'https://push.example.test'); assert.equal(claims.sub, 'mailto:a@b.test');
  assert.ok(claims.exp > NOW / 1000 && claims.exp - NOW / 1000 <= 24 * 3600);
  const sig = Buffer.from(m[3], 'base64url'); assert.equal(sig.length, 64);
  const pk = createPublicKey({ key: { kty: 'EC', crv: 'P-256', x: jwk.x, y: jwk.y }, format: 'jwk' });
  assert.ok(verify('sha256', Buffer.from(m[1] + '.' + m[2]), { key: pk, dsaEncoding: 'ieee-p1363' }, sig), 'ES256 signature verifies');

  for (const status of [404, 410]) {
    const g = await sendWebPush({ endpoint: 'https://p.test/x', keys: r.keys }, 'x', { fetchFn: async () => new Response(null, { status }), subject: 's', publicKey, privateKey });
    assert.equal(g.gone, true);
  }
  await assert.rejects(sendWebPush({ endpoint: 'http://p.test/x', keys: r.keys }, 'x', { fetchFn, subject: 's', publicKey, privateKey }));
  await assert.rejects(encryptPayload('x'.repeat(5000), r.keys), /too large/);
});
