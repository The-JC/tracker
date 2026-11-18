import test from 'node:test';
import assert from 'node:assert/strict';
import { personForEmail, resolveUser, NOT_ALLOWED_MESSAGE } from '../src/identity.js';

const people = { a: { name: 'Beatrix', email: 'Bea@Example.com' }, b: { name: 'Julian', email: 'julian@example.com' } };

test('personForEmail compares trimmed, lowercase', () => {
  assert.equal(personForEmail('bea@example.com', people), 'a');
  assert.equal(personForEmail('  BEA@EXAMPLE.COM ', people), 'a');
  assert.equal(personForEmail('julian@example.com', people), 'b');
  assert.equal(personForEmail('mallory@example.com', people), null);
  assert.equal(personForEmail('', people), null);
  assert.equal(personForEmail(null, people), null);
});

test('unconfigured (empty) emails never match, not even an empty email', () => {
  const none = { a: { email: '' }, b: { email: '' } };
  assert.equal(personForEmail('', none), null);
  assert.equal(personForEmail('x@y.z', none), null);
  assert.equal(personForEmail('x@y.z', { a: {}, b: {} }), null);
});

test('resolveUser: allowlist, unverified emails and the local shortcut', () => {
  assert.deepEqual(resolveUser({ email: 'julian@example.com', emailVerified: true }, people), { ok: true, me: 'b' });
  assert.deepEqual(resolveUser({ email: 'julian@example.com' }, people), { ok: true, me: 'b' });
  assert.deepEqual(resolveUser({ email: 'julian@example.com', emailVerified: false }, people), { ok: false, error: NOT_ALLOWED_MESSAGE });
  assert.deepEqual(resolveUser({ email: 'eve@example.com', emailVerified: true }, people), { ok: false, error: NOT_ALLOWED_MESSAGE });
  assert.equal(NOT_ALLOWED_MESSAGE, 'This Google account is not on the allowlist');
  assert.equal(resolveUser(null, people).ok, false);
  // localPerson is ignored unless explicitly allowed (i.e. never with Firebase)
  assert.equal(resolveUser({ email: 'eve@example.com', localPerson: 'a' }, people).ok, false);
  assert.deepEqual(resolveUser({ email: 'x@local.test', localPerson: 'a' }, people, { allowLocal: true }), { ok: true, me: 'a' });
});
