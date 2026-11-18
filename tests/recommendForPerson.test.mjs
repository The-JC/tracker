import test from 'node:test';
import assert from 'node:assert/strict';
import { PLAN } from '../src/plan.js';
import { buildWeeks, effectiveStartDate, sortLog } from '../src/scoring.js';
import { recommendNext } from '../src/recommend.js';
import { recommendForPerson, reminderMessage, logToEntries, REMINDER_TAG, REMINDER_URL } from '../src/recommendForPerson.js';

let seq = 0;
const e = (person, date, runType, km, extra = {}) =>
  ({ id: `e${++seq}`, person, sport: 'run', runType, title: 't', date, km, hasPhoto: false, ts: 1000 + seq, ...extra });

// What the app does (store.js computed + NextRunCard before the refactor): sorted log array, effectiveStartDate, buildWeeks, recommendNext.
function appPipeline({ person, log, goals, startDateSetting, todayISO }) {
  const sorted = sortLog(log);
  const startDate = effectiveStartDate(startDateSetting, sorted, todayISO);
  const weeks = buildWeeks(PLAN, goals, sorted, startDate, todayISO);
  return { rec: recommendNext({ weeks, person, log: sorted, goals, todayISO, startDate }), weeks };
}

const fixtures = {
  'plan not started': { person: 'a', log: [], goals: {}, startDateSetting: '2026-03-02', todayISO: '2026-02-27' },
  'monday, empty log': { person: 'a', log: [], goals: {}, startDateSetting: '2026-03-02', todayISO: '2026-03-02' },
  'no start date, no log': { person: 'b', log: [], goals: {}, startDateSetting: null, todayISO: '2026-03-04' },
  'start derived from earliest run': { person: 'a', log: [e('a', '2026-03-03', 'easy', 5)], goals: {}, startDateSetting: null, todayISO: '2026-03-05' },
  'day after a tempo run': {
    person: 'a', goals: {}, startDateSetting: '2026-03-02', todayISO: '2026-03-04',
    log: [e('a', '2026-03-03', 'tempo', 5), e('b', '2026-03-03', 'easy', 4)]
  },
  'ran today': { person: 'a', goals: {}, startDateSetting: '2026-03-02', todayISO: '2026-03-04', log: [e('a', '2026-03-04', 'easy', 5)] },
  'goal override': { person: 'a', goals: { '1-1-1-a': '8' }, startDateSetting: '2026-03-02', todayISO: '2026-03-03', log: [] },
  'week done': {
    person: 'a', goals: {}, startDateSetting: '2026-03-02', todayISO: '2026-03-07',
    log: [e('a', '2026-03-02', 'easy', 5), e('a', '2026-03-03', 'tempo', 5), e('a', '2026-03-05', 'long', 6.5)]
  },
  'long break': { person: 'a', goals: {}, startDateSetting: '2026-03-02', todayISO: '2026-03-18', log: [e('a', '2026-03-03', 'easy', 5)] },
  'after the plan': { person: 'a', goals: {}, startDateSetting: '2026-03-02', todayISO: '2026-12-31', log: [] },
  'non-run activity today': {
    person: 'a', goals: {}, startDateSetting: '2026-03-02', todayISO: '2026-03-03',
    log: [{ id: 'h1', person: 'a', sport: 'hike', date: '2026-03-03', km: 9, title: 'hike', ts: 5 }]
  }
};

test('recommendForPerson equals the app pipeline (buildWeeks + recommendNext) for many fixtures', () => {
  for (const [name, f] of Object.entries(fixtures)) {
    const got = recommendForPerson(f);
    const want = appPipeline(f);
    assert.deepEqual(got.rec, want.rec, name);
    assert.deepEqual(got.weeks, want.weeks, name);
    assert.equal(got.weeks.length, 30);
  }
});

test('the database form of the log (object keyed by id, as the Worker reads it) gives the same result as the app array', () => {
  for (const [name, f] of Object.entries(fixtures)) {
    const asDb = Object.fromEntries(f.log.map(({ id, ...rest }) => [id, rest])); // the id lives in the key
    const got = recommendForPerson({ ...f, log: asDb });
    assert.deepEqual(got.rec, recommendForPerson(f).rec, name);
  }
});

test('missing goals / log / invalid start date do not throw', () => {
  const r = recommendForPerson({ person: 'a', log: null, goals: undefined, startDateSetting: 'garbage', todayISO: '2026-03-04' });
  assert.ok(r.rec && r.weeks.length === 30);
});

test('logToEntries: array or object, sorted newest first, ids from keys, junk dropped', () => {
  const out = logToEntries({ k1: { person: 'a', date: '2026-03-01', ts: 1 }, k2: { person: 'a', date: '2026-03-05', ts: 2, id: 'own' }, bad: null, str: 'x' });
  assert.deepEqual(out.map(x => x.id), ['own', 'k1']);
  assert.deepEqual(logToEntries(undefined), []);
  assert.deepEqual(logToEntries([null, { id: 'z', date: '2026-01-01' }]).map(x => x.id), ['z']);
});

/* ---------- message ---------- */

test('reminderMessage for a run: concise title and the reason as body', () => {
  const { rec } = recommendForPerson({ person: 'a', log: [], goals: {}, startDateSetting: '2026-03-02', todayISO: '2026-03-03' });
  assert.equal(rec.kind, 'run');
  const m = reminderMessage(rec, 'Beatrix');
  assert.equal(m.title, `Today: ${rec.run.type} ${rec.run.km} km`);
  assert.equal(m.body, rec.reason.length > 140 ? m.body : rec.reason);
  assert.ok(m.body.length <= 140);
  assert.equal(m.tag, REMINDER_TAG); assert.equal(m.tag, 'trailhead-reminder');
  assert.equal(m.url, REMINDER_URL); assert.equal(m.url, '/#/feed');
});

test('reminderMessage trims long reasons to 140 chars with an ellipsis', () => {
  const m = reminderMessage({ kind: 'run', run: { type: 'Tempo', km: 5 }, reason: 'word '.repeat(100) });
  assert.equal(m.title, 'Today: Tempo 5 km');
  assert.ok(m.body.length <= 140 && m.body.endsWith('…'));
});

test('reminderMessage: run without km, fractional km, empty reason falls back to the name', () => {
  assert.equal(reminderMessage({ kind: 'run', run: { type: 'Shakeout', km: 0 }, reason: 'r' }).title, 'Today: Shakeout');
  assert.equal(reminderMessage({ kind: 'run', run: { type: 'Long run', km: 6.5 }, reason: 'r' }).title, 'Today: Long run 6.5 km');
  assert.equal(reminderMessage({ kind: 'run', run: { type: 'Easy', km: 5 }, reason: '' }, 'Bea').body, 'Bea, time for your run.');
});

test('reminderMessage for non-run kinds is prefixed "Test: "', () => {
  for (const name of ['ran today', 'week done', 'plan not started', 'after the plan']) {
    const { rec } = recommendForPerson(fixtures[name]);
    const m = reminderMessage(rec, 'Bea');
    assert.ok(m.title.startsWith('Test: '), `${name}: ${m.title}`);
    assert.equal(m.tag, 'trailhead-reminder');
    assert.ok(m.body.length <= 140);
  }
  assert.ok(reminderMessage(null).title.startsWith('Test: '));
});
