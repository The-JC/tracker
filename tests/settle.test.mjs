import test from 'node:test';
import assert from 'node:assert/strict';
import { settle } from '../src/utils/settle.js';

test('settle passes through a fast result', async () => {
  assert.equal(await settle(Promise.resolve(42), 50), 42);
});

test('settle resolves "queued" when the write never acknowledges (offline)', async () => {
  assert.equal(await settle(new Promise(() => {}), 20), 'queued');
});

test('settle still rejects on real errors', async () => {
  await assert.rejects(settle(Promise.reject(new Error('PERMISSION_DENIED')), 50), /PERMISSION_DENIED/);
});

test('a write that fails after the timeout does not cause an unhandled rejection', async () => {
  let rej;
  const p = new Promise((_, r) => { rej = r; });
  assert.equal(await settle(p, 10), 'queued');
  rej(new Error('late'));
  await new Promise(r => setTimeout(r, 10));
});
