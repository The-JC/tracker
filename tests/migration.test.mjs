import test from 'node:test';
import assert from 'node:assert/strict';
import { PLAN } from '../src/plan.js';
import { migrateLegacy } from '../src/migration.js';
import { toISODate, pointsFor } from '../src/scoring.js';

const NOW = 1_800_000_000_000;

// Realistic snapshot of the old app's database root.
const snapshot = {
  nameA: 'Beatrix', nameB: 'Julian',
  checks: {
    '1-1-0-a': true, '1-1-1-a': true, '1-1-2-a': false, '1-1-0-b': true,
    '1-27-2-b': true, '1-30-1-a': true /* shakeout without km */, '1-30-2-a': true, '9-9-9-a': true /* unknown */
  },
  goals: { '1-1-0-a': '5', '1-1-1-a': '5.5', '1-1-0-b': '', '1-27-2-b': '20', '1-30-1-a': '', '1-30-2-a': '21.1' },
  activities: {
    a: [
      { id: 'activity-a-1700000000000-1', activity: 'hiking', minutes: 12, ts: 1700000000000 },
      { id: 'activity-a-1700100000000-2', activity: 'cycling', minutes: 60, ts: 1700100000000 },
      { activity: 'weird', minutes: 5, ts: 1700200000000 }
    ],
    b: [{ id: 'activity-b-1', activity: 'swimming', minutes: '45', ts: 1700300000000 }, { activity: 'strength', minutes: 0 }]
  }
};

test('checked runs become imported run entries', () => {
  const es = migrateLegacy(snapshot, PLAN, NOW);
  const byId = Object.fromEntries(es.map(e => [e.id, e]));
  const e = byId['imp-1-1-1-a'];
  assert.deepEqual(e, {
    id: 'imp-1-1-1-a', person: 'a', sport: 'run', runType: 'tempo', title: 'Week 1 · Tempo', date: null,
    km: 5.5, week: 1, hasPhoto: false, imported: true, ts: NOW
  });
  assert.equal(byId['imp-1-1-0-a'].km, 5);
  assert.equal(byId['imp-1-1-0-b'].km, 5, 'empty override falls back to the plan default');
  assert.equal(byId['imp-1-1-0-b'].person, 'b');
  assert.equal(byId['imp-1-27-2-b'].km, 20);
  assert.equal(byId['imp-1-30-2-a'].title, 'Week 30 · Race day');
  assert.equal(byId['imp-1-30-2-a'].runType, 'race');
  assert.ok(!byId['imp-1-1-2-a'], 'unchecked');
  assert.ok(!byId['imp-1-30-1-a'], 'no distance, skipped');
  assert.ok(!Object.keys(byId).some(k => k.includes('9-9-9')), 'unknown run id ignored');
});

test('legacy activities (array shape) map sports and keep ts', () => {
  const es = migrateLegacy(snapshot, PLAN, NOW).filter(e => e.id.startsWith('imp-act-'));
  assert.equal(es.length, 4);
  const hike = es.find(e => e.sport === 'hike');
  assert.equal(hike.km, 12);
  assert.equal(hike.person, 'a');
  assert.equal(hike.ts, 1700000000000);
  assert.equal(hike.date, toISODate(1700000000000));
  assert.equal(pointsFor(hike), 6);
  const cycle = es.find(e => e.sport === 'cycle');
  assert.equal(cycle.durationMin, 60);
  assert.equal(cycle.km, undefined);
  const swim = es.find(e => e.sport === 'swim');
  assert.equal(swim.person, 'b');
  assert.equal(swim.durationMin, 45);
  assert.equal(es.find(e => e.title === 'Hike' && e.ts === 1700200000000).sport, 'hike', 'unknown activity defaults to hiking');
  assert.equal(new Set(es.map(e => e.id)).size, es.length);
  for (const e of es) { assert.equal(e.imported, true); assert.equal(e.hasPhoto, false); }
});

test('legacy activities (very old map shape)', () => {
  const es = migrateLegacy({
    activities: {
      a: {
        'activity-a-cycling': { checked: true, value: '40', ts: 1690000000000 },
        'activity-a-hiking': { checked: false },
        'activity-b-swimming': { checked: true, value: 30 },
        'activity-a-9': { activity: 'workout', value: 20 }
      }
    }
  }, PLAN, NOW);
  assert.deepEqual(es.map(e => [e.sport, e.person, e.durationMin]).sort(), [['cycle', 'a', 40], ['workout', 'a', 20]]);
  assert.equal(es.find(e => e.sport === 'workout').ts, NOW, 'missing ts falls back to now');
});

test('sparse array returned by Firebase as an object', () => {
  const es = migrateLegacy({ activities: { a: { 0: { activity: 'swimming', minutes: 20, ts: 1 }, 2: { activity: 'workout', minutes: 30, ts: 2 } } } }, PLAN, NOW);
  assert.deepEqual(es.map(e => e.sport).sort(), ['swim', 'workout']);
});

test('empty / missing snapshot is fine and migration is deterministic (idempotent ids)', () => {
  assert.deepEqual(migrateLegacy(null, PLAN, NOW), []);
  assert.deepEqual(migrateLegacy({}, PLAN, NOW), []);
  assert.deepEqual(migrateLegacy({ checks: null, goals: null, activities: null }, PLAN, NOW), []);
  const a = migrateLegacy(snapshot, PLAN, NOW).map(e => e.id);
  const b = migrateLegacy(snapshot, PLAN, NOW + 5).map(e => e.id);
  assert.deepEqual(a, b);
});

test('Firebase-illegal characters never appear in ids', () => {
  const es = migrateLegacy({ activities: { a: [{ id: 'a.b#c$d[e]f/g', activity: 'hiking', minutes: 3 }] } }, PLAN, NOW);
  assert.match(es[0].id, /^imp-act-a-a_b_c_d_e_f_g$/);
});
