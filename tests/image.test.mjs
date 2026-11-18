import test from 'node:test';
import assert from 'node:assert/strict';
import { fitSize, shrinkToBudget, compressImage, DEFAULTS } from '../src/utils/image.js';

test('fitSize scales the long side down, keeps aspect, never upscales', () => {
  assert.deepEqual(fitSize(4000, 3000, 1000), { width: 1000, height: 750 });
  assert.deepEqual(fitSize(3000, 4000, 1000), { width: 750, height: 1000 });
  assert.deepEqual(fitSize(800, 600, 1000), { width: 800, height: 600 });
  assert.deepEqual(fitSize(10000, 1, 1000), { width: 1000, height: 1 });
});

test('shrinkToBudget returns the first attempt that fits', async () => {
  const calls = [];
  const render = (dim, q) => { calls.push([dim, Math.round(q * 100) / 100]); return 'x'.repeat(q > 0.55 ? 900 : 100); };
  const out = await shrinkToBudget(render, { ...DEFAULTS, maxBytes: 500 });
  assert.equal(out.length, 100);
  assert.deepEqual(calls, [[1000, 0.7], [1000, 0.6], [1000, 0.5]]);
});

test('shrinkToBudget lowers quality first, then dimensions, and stops at the floor', async () => {
  const calls = [];
  const huge = () => 'x'.repeat(10000);
  const out = await shrinkToBudget((d, q) => { calls.push([d, q]); return huge(); }, { ...DEFAULTS, maxBytes: 100 });
  assert.equal(out.length, 10000); // best effort
  assert.ok(calls.every(([, q]) => q >= DEFAULTS.minQuality - 1e-9));
  assert.ok(calls[0][0] === 1000 && calls[calls.length - 1][0] < 1000);
  assert.ok(calls.length < 30);
  // dimension shrinks only after the quality floor was hit at the previous dimension
  const firstSmaller = calls.findIndex(([d]) => d < 1000);
  assert.equal(calls[firstSmaller - 1][1], DEFAULTS.minQuality);
});

test('shrinkToBudget supports async render', async () => {
  const out = await shrinkToBudget(async () => 'ok', { ...DEFAULTS });
  assert.equal(out, 'ok');
});

test('compressImage rejects non-images with a friendly message', async () => {
  await assert.rejects(() => compressImage({ type: 'application/pdf', name: 'a.pdf' }), /not a photo/);
  await assert.rejects(() => compressImage({ type: '', name: 'notes.txt' }), /not a photo/);
  await assert.rejects(() => compressImage(null), /not a photo/);
});
