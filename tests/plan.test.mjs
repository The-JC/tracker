import test from 'node:test';
import assert from 'node:assert/strict';
import { PLAN, RUN_TYPES, SPORTS, RUN_TYPE_KEY_BY_NAME, PLAN_RUN_BY_ID, TOTAL_WEEKS } from '../src/plan.js';

// Per-person planned km, copied from data-km on the old <details class="week"> elements.
const OLD_DATA_KM = [16.5, 16.5, 19, 19, 22, 22, 22.5, 22.5, 24.5, 24.5, 25.5, 25.5, 28, 28, 29,
  22.5, 27, 29, 30, 24.5, 32, 34, 26, 35, 35.5, 26, 35, 26, 18, 25.1];

test('plan has 30 weeks x 2 people x 3 runs', () => {
  assert.equal(PLAN.length, TOTAL_WEEKS);
  PLAN.forEach((w, i) => {
    assert.equal(w.n, i + 1);
    for (const p of ['a', 'b']) assert.equal(w.runs[p].length, 3, `week ${w.n} ${p}`);
  });
});

test('planned km per week matches the old data-km attributes', () => {
  PLAN.forEach((w, i) => {
    for (const p of ['a', 'b']) {
      const sum = w.runs[p].reduce((s, r) => s + (r.km || 0), 0);
      assert.ok(Math.abs(sum - OLD_DATA_KM[i]) < 1e-9, `week ${w.n} ${p}: ${sum} vs ${OLD_DATA_KM[i]}`);
    }
  });
});

test('run ids follow the legacy format and are unique', () => {
  const ids = new Set();
  for (const w of PLAN) for (const p of ['a', 'b']) {
    w.runs[p].forEach((r, idx) => {
      assert.equal(r.id, `1-${w.n}-${idx}-${p}`);
      assert.ok(!ids.has(r.id));
      ids.add(r.id);
    });
  }
  assert.equal(ids.size, 180);
  assert.equal(Object.keys(PLAN_RUN_BY_ID).length, 180);
});

test('week kinds and tags', () => {
  const kinds = PLAN.filter(w => w.kind).map(w => `${w.n}:${w.kind}`);
  assert.deepEqual(kinds, ['16:cutback', '20:cutback', '23:cutback', '26:cutback', '27:peak', '30:race-week']);
  assert.deepEqual(PLAN.filter(w => w.tag).map(w => `${w.n}:${w.tag}`),
    ['16:Cutback', '20:Cutback', '23:Cutback', '26:Cutback', '27:Peak', '28:Taper', '29:Taper', '30:Race week']);
});

test('run types, multipliers and name map', () => {
  assert.deepEqual(RUN_TYPES.map(t => [t.key, t.mult]),
    [['easy', 1], ['long', 1.3], ['tempo', 1.6], ['speed', 1.8], ['shakeout', 1], ['race', 3]]);
  for (const t of RUN_TYPES) { assert.ok(t.why && t.how); assert.equal(RUN_TYPE_KEY_BY_NAME[t.name], t.key); }
  for (const w of PLAN) for (const p of ['a', 'b']) for (const r of w.runs[p]) {
    assert.equal(RUN_TYPE_KEY_BY_NAME[r.type], r.runType, r.id);
    assert.equal(RUN_TYPES.find(t => t.key === r.runType).mult, r.mult, r.id);
  }
});

test('race week: shakeout has no default km, race day is 21.1', () => {
  const w = PLAN[29];
  assert.equal(w.runs.a[1].km, null);
  assert.equal(w.runs.a[2].km, 21.1);
  assert.equal(w.runs.a[2].type, 'Race day');
});

test('sports and rates', () => {
  const rates = Object.fromEntries(SPORTS.map(s => [s.key, [s.requires, s.rate, s.per]]));
  assert.deepEqual(rates, {
    run: ['km', null, 1], hike: ['km', 0.5, 1], cycle: ['durationMin', 0.4, 30],
    swim: ['durationMin', 0.6, 30], strength: ['durationMin', 0.5, 30], workout: ['durationMin', 0.6, 30]
  });
});
