import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createECDH, randomBytes } from 'node:crypto';
import { handleRequest, normalizeSubs, buildPayload } from '../src/handler.js';
import { originAllowed } from '../src/cors.js';
import { ENV, makeIssuer } from './helpers.js';

const NOW = Math.floor(Date.now() / 1000) * 1000;
const iss = makeIssuer();

async function vapid() {
  const kp = await crypto.subtle.generateKey({ name: 'ECDSA', namedCurve: 'P-256' }, true, ['sign', 'verify']);
  const jwk = await crypto.subtle.exportKey('jwk', kp.privateKey);
  return {
    VAPID_PRIVATE_KEY: jwk.d,
    VAPID_PUBLIC_KEY: Buffer.concat([Buffer.from([4]), Buffer.from(jwk.x, 'base64url'), Buffer.from(jwk.y, 'base64url')]).toString('base64url')
  };
}
const sub = () => {
  const e = createECDH('prime256v1'); e.generateKeys();
  return { endpoint: 'https://push.example.test/' + randomBytes(4).toString('hex'), keys: { p256dh: e.getPublicKey().toString('base64url'), auth: randomBytes(16).toString('base64url') }, ts: 1 };
};

// Fake world: DB contents + push service behaviour; records every call.
function world({ events = {}, subs = {}, pushStatus = {} } = {}) {
  const calls = [];
  const fetchFn = async (url, init = {}) => {
    const u = new URL(url);
    calls.push({ method: init.method || 'GET', url: u });
    if (u.host === 'db.example.test') {
      assert.ok(u.searchParams.get('auth'), 'DB calls carry the caller token');
      const path = u.pathname.replace(/\.json$/, '').slice(1).split('/');
      if (init.method === 'DELETE') { return new Response('null'); }
      if (path[1] === 'events') return Response.json(events[path[2]] ?? null);
      if (path[1] === 'pushSubs') return Response.json(subs[path[2]] ?? null);
    }
    return new Response(null, { status: pushStatus[url] || 201 });
  };
  return { fetchFn, calls };
}

async function call(w, { token = iss.mint(), body = { eventId: 'ev1' }, headers = {}, method = 'POST', path = '/notify', env, seen = new Map(), now = NOW } = {}) {
  const e = { ...ENV, ...(await vapid()), ...env };
  const h = { 'Content-Type': 'application/json', ...(token ? { Authorization: `Bearer ${token}` } : {}), ...headers };
  const req = new Request('https://w.example.test' + path, { method, headers: h, body: method === 'POST' ? JSON.stringify(body) : undefined });
  const res = await handleRequest(req, e, { fetchFn: w.fetchFn, now: () => now, getCerts: iss.getCerts, seen });
  return { res, json: res.status === 204 ? null : await res.json() };
}

const goodEvent = (o = {}) => ({ actor: 'a', kind: 'activity', text: 'Beatrix logged an 8 km run', ts: NOW - 1000, ...o });

test('happy path: person a notifies b, payload from DB event only', async () => {
  const s = sub();
  const w = world({ events: { ev1: goodEvent() }, subs: { b: { h1: s } } });
  const { res, json } = await call(w, { body: { eventId: 'ev1', text: 'EVIL' } });
  assert.equal(res.status, 200); assert.deepEqual(json, { sent: 1, removed: 0 });
  const push = w.calls.find(c => c.url.host === 'push.example.test');
  assert.ok(push && push.method === 'POST');
  assert.ok(w.calls.some(c => c.url.pathname === '/trailhead-tracker-v1/pushSubs/b.json'));
});

test('person b notifies a; legacy single-object subscription works', async () => {
  const s = sub();
  const w = world({ events: { ev1: goodEvent({ actor: 'b' }) }, subs: { a: s } });
  const { json } = await call(w, { token: iss.mint({ email: 'person-b@example.test' }) });
  assert.deepEqual(json, { sent: 1, removed: 0 });
});

test('auth failures: missing/garbage token 401, non-allowlisted 403', async () => {
  const w = world({ events: { ev1: goodEvent() } });
  assert.equal((await call(w, { token: null })).res.status, 401);
  assert.equal((await call(w, { token: 'x.y.z' })).res.status, 401);
  assert.equal((await call(w, { token: iss.mint({ email: 'eve@example.test' }) })).res.status, 403);
  assert.equal(w.calls.length, 0, 'no DB access before auth');
});

test('event checks: foreign actor 403, too old 410, future 400, missing 404, bad id 400', async () => {
  const mk = ev => world({ events: { ev1: ev } });
  assert.equal((await call(mk(goodEvent({ actor: 'b' })))).res.status, 403);
  assert.equal((await call(mk(goodEvent({ ts: NOW - 5 * 60 * 1000 - 1 })))).res.status, 410);
  assert.equal((await call(mk(goodEvent({ ts: NOW - 5 * 60 * 1000 + 5000 })))).res.status, 200);
  assert.equal((await call(mk(goodEvent({ ts: NOW + 10 * 60 * 1000 })))).res.status, 400);
  assert.equal((await call(mk(goodEvent({ ts: undefined })))).res.status, 400);
  assert.equal((await call(world(), { body: { eventId: 'nope' } })).res.status, 404);
  for (const id of ['../x', 'a/b', '', 5, null]) assert.equal((await call(world(), { body: { eventId: id } })).res.status, 400);
});

test('replay guard: second call for same eventId is a no-op; failure releases it', async () => {
  const seen = new Map();
  const w = world({ events: { ev1: goodEvent() }, subs: { b: { h1: sub() } } });
  assert.equal((await call(w, { seen })).json.sent, 1);
  const again = await call(w, { seen });
  assert.deepEqual(again.json, { sent: 0, removed: 0, duplicate: true });

  const seen2 = new Map();
  const s = sub();
  const bad = world({ events: { ev1: goodEvent() }, subs: { b: { h1: s } }, pushStatus: { [s.endpoint]: 503 } });
  assert.equal((await call(bad, { seen: seen2 })).json.sent, 0);
  assert.equal(seen2.has('ev1'), false, 'transient failure can be retried');
});

test('dead subscriptions (410/404) are deleted from the DB with the caller token', async () => {
  const dead = sub(), gone = sub(), live = sub();
  const w = world({ events: { ev1: goodEvent() }, subs: { b: { d: dead, g: gone, l: live } }, pushStatus: { [dead.endpoint]: 410, [gone.endpoint]: 404 } });
  const { json } = await call(w);
  assert.deepEqual(json, { sent: 1, removed: 2 });
  const dels = w.calls.filter(c => c.method === 'DELETE').map(c => c.url.pathname).sort();
  assert.deepEqual(dels, ['/trailhead-tracker-v1/pushSubs/b/d.json', '/trailhead-tracker-v1/pushSubs/b/g.json']);
});

test('no subscriptions -> sent 0; unconfigured VAPID key -> 500', async () => {
  assert.deepEqual((await call(world({ events: { ev1: goodEvent() } }))).json, { sent: 0, removed: 0 });
  const w = world({ events: { ev1: goodEvent() }, subs: { b: { h: sub() } } });
  assert.equal((await call(w, { env: { VAPID_PUBLIC_KEY: 'REPLACE_ME' } })).res.status, 500);
});

test('CORS: preflight, allowed/denied origins, health', async () => {
  const w = world();
  const ok = await call(w, { method: 'OPTIONS', path: '/notify', headers: { Origin: 'https://trailhead.pages.dev' } });
  assert.equal(ok.res.status, 204);
  assert.equal(ok.res.headers.get('access-control-allow-origin'), 'https://trailhead.pages.dev');
  assert.match(ok.res.headers.get('access-control-allow-headers'), /Authorization/);
  assert.equal((await call(w, { method: 'OPTIONS', headers: { Origin: 'https://evil.example' } })).res.status, 403);
  const h = await call(w, { method: 'GET', path: '/health', headers: { Origin: 'http://localhost:5173' } });
  assert.deepEqual(h.json, { ok: true });
  assert.equal((await call(w, { method: 'GET', path: '/nope' })).res.status, 404);
  assert.equal((await call(w, { method: 'GET', path: '/notify' })).res.status, 405);
});

test('originAllowed: exact and wildcard-subdomain matching', () => {
  const l = 'https://*.pages.dev, http://localhost:5173';
  assert.ok(originAllowed('https://a.pages.dev', l));
  assert.ok(originAllowed('https://x.y.pages.dev', l));
  assert.ok(originAllowed('http://localhost:5173', l));
  assert.ok(!originAllowed('https://pages.dev', l));
  assert.ok(!originAllowed('http://a.pages.dev', l));
  assert.ok(!originAllowed('https://evilpages.dev', l));
  assert.ok(!originAllowed('https://a.pages.dev.evil.com', l));
  assert.ok(!originAllowed('http://localhost:5174', l));
  assert.ok(!originAllowed('null', l)); assert.ok(!originAllowed(undefined, l));
});

test('normalizeSubs / buildPayload', () => {
  const s = sub();
  assert.equal(normalizeSubs({ a: s, b: { endpoint: 'http://x', keys: s.keys }, 'bad/key': s }, 'b').length, 1);
  assert.equal(normalizeSubs(s, 'a')[0].path, 'trailhead-tracker-v1/pushSubs/a');
  assert.deepEqual(normalizeSubs(null, 'a'), []);
  assert.deepEqual(buildPayload({ text: ' hi \n there ' }, 'e9'), { title: 'Trailhead', body: 'hi there', tag: 'e9', url: '/' });
});
