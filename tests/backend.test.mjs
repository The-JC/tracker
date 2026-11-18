import test from 'node:test';
import assert from 'node:assert/strict';
import { createLocalBackend, makeKey } from '../src/backend.js';

const mk = () => createLocalBackend({ storage: null, persist: false });
const tick = () => new Promise(r => setTimeout(r, 0));

test('set/get/update/remove with Firebase-like semantics', async () => {
  const b = mk();
  await b.set('r/a', { x: 1, y: null, z: { w: undefined } });
  assert.deepEqual(await b.get('r/a'), { x: 1 });
  await b.update('r', { 'a/x': 2, 'b': 'hi' });
  assert.deepEqual(await b.get('r'), { a: { x: 2 }, b: 'hi' });
  await b.remove('r/a/x');
  assert.equal(await b.get('r/a'), null, 'empty parents are pruned');
  assert.equal(await b.get('r/nope'), null);
});

test('subscribe fires initially and on writes to ancestors/descendants, not unrelated paths', async () => {
  const b = mk();
  const seenLog = [], seenOther = [];
  const un = b.subscribe('r/log', v => seenLog.push(v));
  b.subscribe('r/other', v => seenOther.push(v));
  await tick();
  assert.deepEqual(seenLog, [null]);
  await b.set('r/log/k1', { a: 1 });
  await b.set('r/log/k1/kudos/a', true);
  await b.set('r', { log: { k2: { a: 2 } } });
  assert.deepEqual(seenLog.at(-1), { k2: { a: 2 } });
  assert.equal(seenLog.length, 4);
  assert.equal(seenOther.length, 2, 'initial + ancestor write only');
  un();
  await b.set('r/log/k3', 1);
  assert.equal(seenLog.length, 4, 'unsubscribed');
});

test('limitToLast keeps the newest keys', async () => {
  const b = mk();
  for (const k of ['a', 'b', 'c', 'd']) await b.set(`e/${k}`, { k });
  let v;
  b.subscribe('e', x => { v = x; }, { limitToLast: 2 });
  await tick();
  assert.deepEqual(Object.keys(v), ['c', 'd']);
});

test('push keys sort chronologically; claimOnce only succeeds once', async () => {
  const b = mk();
  const k1 = makeKey(), k2 = makeKey();
  assert.ok(k1 < k2);
  const key = await b.push('m', { t: 1 });
  assert.deepEqual(await b.get(`m/${key}`), { t: 1 });
  assert.equal(await b.claimOnce('s/flag', 123), true);
  assert.equal(await b.claimOnce('s/flag', 456), false);
  assert.equal(await b.get('s/flag'), 123);
});

test('persistence round-trip through storage', async () => {
  const mem = new Map();
  const storage = { getItem: k => (mem.has(k) ? mem.get(k) : null), setItem: (k, v) => mem.set(k, String(v)), removeItem: k => mem.delete(k) };
  const b1 = createLocalBackend({ storage });
  await b1.set('r/x', 5);
  const b2 = createLocalBackend({ storage });
  assert.equal(await b2.get('r/x'), 5);
});

test('local Google sign-in: person a/b or a stranger; user is passed to listeners', async () => {
  const b = mk();
  const seen = [];
  b.onAuth(u => seen.push(u && [u.localPerson, u.email.includes('@'), u.emailVerified]));
  await tick();
  await b.signInWithGoogle('b');
  await b.signInWithGoogle('stranger');
  await b.signOut();
  assert.deepEqual(seen, [null, ['b', true, true], [null, true, true], null]);
  assert.equal(typeof b.redirectResult, 'function');
});

test('local sign-in persists across instances until sign-out', async () => {
  const mem = new Map();
  const storage = { getItem: k => (mem.has(k) ? mem.get(k) : null), setItem: (k, v) => mem.set(k, String(v)), removeItem: k => mem.delete(k) };
  const b1 = createLocalBackend({ storage });
  await b1.signInWithGoogle('a');
  let u; createLocalBackend({ storage }).onAuth(x => { u = x; });
  await tick();
  assert.equal(u.localPerson, 'a');
  await b1.signOut();
  let u2 = 'unset'; createLocalBackend({ storage }).onAuth(x => { u2 = x; });
  await tick();
  assert.equal(u2, null);
});
