import test from 'node:test';
import assert from 'node:assert/strict';
import { isNewVersion, fetchRemoteBuild, shouldCheck, MIN_GAP_MS } from '../src/utils/updateCheck.js';

const jsonRes = (body, ok = true) => ({ ok, json: async () => body });

test('isNewVersion: differing ids mean an update, dev and empty never do', () => {
  assert.equal(isNewVersion('abc', 'abd'), true);
  assert.equal(isNewVersion('abc', 'abc'), false);
  assert.equal(isNewVersion('dev', 'abc'), false);
  assert.equal(isNewVersion('abc', ''), false);
  assert.equal(isNewVersion('abc', null), false);
  assert.equal(isNewVersion('abc', undefined), false);
});

test('fetchRemoteBuild: reads the build id and bypasses caches', async () => {
  let seen;
  const build = await fetchRemoteBuild({
    url: '/version.json', now: 123,
    fetchFn: async (url, init) => { seen = { url, init }; return jsonRes({ build: 'x1', builtAt: 'now' }); }
  });
  assert.equal(build, 'x1');
  assert.equal(seen.url, '/version.json?t=123');
  assert.equal(seen.init.cache, 'no-store');
});

test('fetchRemoteBuild: null on http error, network error, bad json shape or HTML fallback', async () => {
  assert.equal(await fetchRemoteBuild({ fetchFn: async () => jsonRes({}, false) }), null);
  assert.equal(await fetchRemoteBuild({ fetchFn: async () => { throw new Error('offline'); } }), null);
  assert.equal(await fetchRemoteBuild({ fetchFn: async () => jsonRes({ build: 5 }) }), null);
  assert.equal(await fetchRemoteBuild({ fetchFn: async () => ({ ok: true, json: async () => { throw new SyntaxError('<html'); } }) }), null);
  assert.equal(await fetchRemoteBuild({ fetchFn: null }), null);
});

test('shouldCheck throttles unless forced', () => {
  assert.equal(shouldCheck({ now: 1000, last: 0 }), true);
  assert.equal(shouldCheck({ now: 1000, last: 900 }), false);
  assert.equal(shouldCheck({ now: 900 + MIN_GAP_MS, last: 900 }), true);
  assert.equal(shouldCheck({ now: 1000, last: 900, force: true }), true);
});
