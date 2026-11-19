import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createECDH, randomBytes } from 'node:crypto';
import { handleRequest, normalizeSubs, buildPayload, buildTestPayload } from '../src/handler.js';
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
function world({ events = {}, subs = {}, pushStatus = {}, names = {}, db = {} } = {}) {
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
      if (path[1] === 'nameA' || path[1] === 'nameB') return Response.json(names[path[1]] ?? null);
      if (['log', 'goals', 'settings', 'plans'].includes(path[1])) return Response.json(db[path[1]] ?? null);
    }
    return new Response(null, { status: pushStatus[url] || 201 });
  };
  return { fetchFn, calls };
}

async function call(w, { token = iss.mint(), body = { eventId: 'ev1' }, headers = {}, method = 'POST', path = '/notify', env, seen = new Map(), testSeen = new Map(), now = NOW } = {}) {
  const e = { ...ENV, ...(await vapid()), ...env };
  const h = { 'Content-Type': 'application/json', ...(token ? { Authorization: `Bearer ${token}` } : {}), ...headers };
  const req = new Request('https://w.example.test' + path, { method, headers: h, body: method === 'POST' ? JSON.stringify(body) : undefined });
  const res = await handleRequest(req, e, { fetchFn: w.fetchFn, now: () => now, getCerts: iss.getCerts, seen, testSeen });
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
  assert.deepEqual(h.json, { ok: true, scheduler: false });
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

/* ---------- test notifications: {"test":"self"|"other"} ---------- */

const tokenB = () => iss.mint({ email: 'person-b@example.test' });
const pushes = w => w.calls.filter(c => c.url.host === 'push.example.test');

test('test self: sends to the caller own subscriptions, no event read', async () => {
  const s = sub();
  const w = world({ subs: { a: { h1: s }, b: { h2: sub() } } });
  const { res, json } = await call(w, { body: { test: 'self' } });
  assert.equal(res.status, 200); assert.deepEqual(json, { sent: 1, removed: 0, target: 'self' });
  assert.deepEqual(pushes(w).map(c => c.url.href), [s.endpoint]);
  assert.ok(!w.calls.some(c => c.url.pathname.includes('/events/')), 'no event is read');
  assert.ok(w.calls.some(c => c.url.pathname === '/trailhead-tracker-v1/pushSubs/a.json'));
});

test('test other: sends to the other person, using the caller name from the DB (fallback to the map)', async () => {
  const s = sub();
  const w = world({ subs: { b: { h1: s }, a: { h2: sub() } }, names: { nameA: 'Bea' } });
  const { json } = await call(w, { body: { test: 'other' } });
  assert.deepEqual(json, { sent: 1, removed: 0, target: 'other' });
  assert.deepEqual(pushes(w).map(c => c.url.href), [s.endpoint]);
  // b -> a with no names in the DB: default "Julian"
  const w2 = world({ subs: { a: { h: sub() } } });
  assert.deepEqual((await call(w2, { token: tokenB(), body: { test: 'other' } })).json, { sent: 1, removed: 0, target: 'other' });
  assert.ok(w2.calls.some(c => c.url.pathname === '/trailhead-tracker-v1/nameB.json'));
});

test('buildTestPayload texts, tag and url', () => {
  assert.deepEqual(buildTestPayload('self'), { title: 'Trailhead', body: 'Test notification \u2014 push is working on this device \u{1F389}', tag: 'trailhead-test', url: '/' });
  assert.deepEqual(buildTestPayload('other', 'Beatrix'), { title: 'Trailhead', body: 'Beatrix sent you a test notification', tag: 'trailhead-test', url: '/' });
});

test('test: recipient without subscription -> 200 no-subscription, nothing pushed', async () => {
  const w = world({ subs: { a: { h: sub() } } });
  const { res, json } = await call(w, { body: { test: 'other' } });
  assert.equal(res.status, 200);
  assert.deepEqual(json, { sent: 0, removed: 0, target: 'other', reason: 'no-subscription' });
  assert.equal(pushes(w).length, 0);
});

test('test: dead subscriptions are cleaned up like for events', async () => {
  const dead = sub(), live = sub();
  const w = world({ subs: { a: { d: dead, l: live } }, pushStatus: { [dead.endpoint]: 410 } });
  assert.deepEqual((await call(w, { body: { test: 'self' } })).json, { sent: 1, removed: 1, target: 'self' });
  assert.deepEqual(w.calls.filter(c => c.method === 'DELETE').map(c => c.url.pathname), ['/trailhead-tracker-v1/pushSubs/a/d.json']);
});

test('test: rate limit 1 per 10 s per actor, 429 with Retry-After', async () => {
  const testSeen = new Map();
  const w = world({ subs: { a: { h: sub() }, b: { h: sub() } } });
  assert.equal((await call(w, { body: { test: 'self' }, testSeen })).res.status, 200);
  const r = await call(w, { body: { test: 'other' }, testSeen, now: NOW + 4000 });
  assert.equal(r.res.status, 429);
  assert.equal(r.res.headers.get('retry-after'), '6');
  assert.equal(pushes(w).length, 1, 'the limited request pushes nothing');
  // the other person has their own budget; the same person may test again after 10 s
  assert.equal((await call(w, { token: tokenB(), body: { test: 'self' }, testSeen, now: NOW + 4000 })).res.status, 200);
  assert.equal((await call(w, { body: { test: 'self' }, testSeen, now: NOW + 10000 })).res.status, 200);
});

test('test: bad value 400, unauthenticated 401, not allowlisted 403, no DB access', async () => {
  const w = world({ subs: { a: { h: sub() } } });
  for (const t of ['both', '', 5, null, ['self'], { x: 1 }]) assert.equal((await call(w, { body: { test: t } })).res.status, 400, JSON.stringify(t));
  assert.equal((await call(w, { token: null, body: { test: 'self' } })).res.status, 401);
  assert.equal((await call(w, { token: 'x.y.z', body: { test: 'self' } })).res.status, 401);
  assert.equal((await call(w, { token: iss.mint({ email: 'eve@example.test' }), body: { test: 'self' } })).res.status, 403);
  assert.equal(w.calls.length, 0);
});

test('test: CORS headers and origin check apply; eventId flow still validates eventId', async () => {
  const w = world({ subs: { a: { h: sub() } } });
  const ok = await call(w, { body: { test: 'self' }, headers: { Origin: 'https://trailhead.pages.dev' } });
  assert.equal(ok.res.headers.get('access-control-allow-origin'), 'https://trailhead.pages.dev');
  assert.equal((await call(w, { body: { test: 'self' }, headers: { Origin: 'https://evil.example' } })).res.status, 403);
  assert.equal((await call(world(), { body: {} })).res.status, 400);
});

/* ---------- /health scheduler flag and {"test":"reminder"} ---------- */

const T0 = Date.parse('2026-03-03T10:00:00Z'); // a Tuesday of plan week 1 (start 2026-03-02)
const tokenAt = (ms, claims = {}) => iss.mint(claims, { nowS: Math.floor(ms / 1000) });
const SA = JSON.stringify({ client_email: 'sa@p.iam.gserviceaccount.com', private_key: '-----BEGIN PRIVATE KEY-----\nAAAA\n-----END PRIVATE KEY-----\n' });

test('/health reports scheduler true only when the service account secret parses; nothing sensitive', async () => {
  const w = world();
  assert.deepEqual((await call(w, { method: 'GET', path: '/health' })).json, { ok: true, scheduler: false });
  assert.deepEqual((await call(w, { method: 'GET', path: '/health', env: { FIREBASE_SERVICE_ACCOUNT: SA } })).json, { ok: true, scheduler: true });
  assert.deepEqual((await call(w, { method: 'GET', path: '/health', env: { FIREBASE_SERVICE_ACCOUNT: '{not json' } })).json, { ok: true, scheduler: false });
  assert.deepEqual((await call(w, { method: 'GET', path: '/health', env: { FIREBASE_SERVICE_ACCOUNT: '{}' } })).json, { ok: true, scheduler: false });
});

test('test reminder: builds the caller own recommendation with the caller token and pushes it to the caller only', async () => {
  const s = sub();
  const w = world({ subs: { a: { h1: s }, b: { h2: sub() } }, db: { settings: { startDate: '2026-03-02' } } });
  const { res, json } = await call(w, { token: tokenAt(T0), now: T0, body: { test: 'reminder' } });
  assert.equal(res.status, 200);
  assert.deepEqual(json, { sent: 1, removed: 0, target: 'self', kind: 'run' });
  assert.deepEqual(pushes(w).map(c => c.url.href), [s.endpoint]);
  const dbPaths = w.calls.filter(c => c.url.host === 'db.example.test').map(c => c.url.pathname);
  for (const p of ['log', 'goals', 'settings', 'plans', 'nameA']) assert.ok(dbPaths.includes(`/trailhead-tracker-v1/${p}.json`), p);
  assert.ok(!dbPaths.some(p => p.includes('/events/') || p.includes('/pushSubs/b')), 'nothing about the other person');
});

test('test reminder: the caller\'s plans/<person> state drives the recommendation (own start date)', async () => {
  const w = world({ subs: { a: { h1: sub() } }, db: { settings: { startDate: '2026-03-02' }, plans: { a: { startDate: '2026-03-09' } } } });
  const { json } = await call(w, { token: tokenAt(T0), now: T0, body: { test: 'reminder' } });
  assert.deepEqual(json, { sent: 1, removed: 0, target: 'self', kind: 'not-started', rest: true });
});

test('test reminder: non-run kind is still sent (Test: prefix is in the message) and reports the kind', async () => {
  const w = world({ subs: { a: { h1: sub() } }, db: { settings: { startDate: '2026-03-09' } } });
  const { json } = await call(w, { token: tokenAt(T0), now: T0, body: { test: 'reminder' } });
  assert.deepEqual(json, { sent: 1, removed: 0, target: 'self', kind: 'not-started', rest: true });
});

test('test reminder: rest:true for every non-run kind (and only then); reason only for a missing subscription', async () => {
  const ran = { x: { person: 'a', sport: 'run', runType: 'easy', km: 5, date: '2026-03-03', ts: 1 } };
  const cases = [
    [{ settings: { startDate: '2026-03-02' }, log: ran }, 'rest'],            // ran today
    [{ settings: { startDate: '2026-03-09' } }, 'not-started'],
    [{ settings: { startDate: '2025-01-01' } }, 'done']                       // long after the plan
  ];
  for (const [db, kind] of cases) {
    const w = world({ subs: { a: { h: sub() } }, db });
    const { json } = await call(w, { token: tokenAt(T0), now: T0, body: { test: 'reminder' } });
    assert.deepEqual(json, { sent: 1, removed: 0, target: 'self', kind, rest: true }, kind);
    assert.ok(!('reason' in json));
  }
  const none = await call(world({ db: { settings: { startDate: '2026-03-09' } } }), { token: tokenAt(T0), now: T0, body: { test: 'reminder' } });
  assert.deepEqual(none.json, { sent: 0, removed: 0, target: 'self', kind: 'not-started', rest: true, reason: 'no-subscription' });
  const run = await call(world({ subs: { a: { h: sub() } }, db: { settings: { startDate: '2026-03-02' } } }), { token: tokenAt(T0), now: T0, body: { test: 'reminder' } });
  assert.ok(!('rest' in run.json), 'a run recommendation carries no rest flag');
});

test('test reminder: uses the tz stored in settings/reminders for "today"', async () => {
  // 2026-03-02 23:30Z is already Tuesday 03 March in Auckland (week 1 Tuesday: run) but Monday in Zurich/UTC
  const at = Date.parse('2026-03-02T23:30:00Z');
  const settings = { startDate: '2026-03-02', reminders: { a: { enabled: true, time: '07:00', tz: 'Pacific/Auckland' } } };
  const w = world({ subs: { a: { h: sub() } }, db: { settings } });
  const { json } = await call(w, { token: tokenAt(at), now: at, body: { test: 'reminder' } });
  assert.equal(json.kind, 'run');
});

test('test reminder: no subscription -> 200 with reason, kind still reported; dead subs cleaned up', async () => {
  const w = world({ db: { settings: { startDate: '2026-03-02' } } });
  assert.deepEqual((await call(w, { token: tokenAt(T0), now: T0, body: { test: 'reminder' } })).json,
    { sent: 0, removed: 0, target: 'self', kind: 'run', reason: 'no-subscription' });
  const dead = sub();
  const w2 = world({ subs: { a: { d: dead } }, pushStatus: { [dead.endpoint]: 410 }, db: { settings: { startDate: '2026-03-02' } } });
  assert.deepEqual((await call(w2, { token: tokenAt(T0), now: T0, body: { test: 'reminder' } })).json, { sent: 0, removed: 1, target: 'self', kind: 'run' });
});

test('test reminder: shares the 10 s rate limit with the other test modes; auth is required', async () => {
  const testSeen = new Map();
  const w = world({ subs: { a: { h: sub() } }, db: { settings: { startDate: '2026-03-02' } } });
  assert.equal((await call(w, { token: tokenAt(T0), now: T0, body: { test: 'self' }, testSeen })).res.status, 200);
  const r = await call(w, { token: tokenAt(T0 + 3000), now: T0 + 3000, body: { test: 'reminder' }, testSeen });
  assert.equal(r.res.status, 429);
  assert.equal((await call(w, { token: null, body: { test: 'reminder' } })).res.status, 401);
  assert.equal((await call(w, { token: iss.mint({ email: 'eve@example.test' }), body: { test: 'reminder' } })).res.status, 403);
});
