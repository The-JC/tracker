import test from 'node:test';
import assert from 'node:assert/strict';
import { PLAN } from '../src/plan.js';
import { buildWeeks, effectiveStartDate, weekOfEntry, addDays, sortLog } from '../src/scoring.js';
import {
  DEFAULT_PLAN_STATE, normalizePlanState, normalizePersonState, normalizePauses, validatePlanPatch,
  effectiveStartFor, weekOfEntryFor, buildWeeksFor, weekWindowsFor, currentWeekIndexFor,
  isPaused, pausedDaysInWeek, weekIsPaused, getPlanTemplate, defaultWeeklyTarget, weeklyTargetFor
} from '../src/planModel.js';
import { recommendForPerson } from '../src/recommendForPerson.js';
import { weekFulfillment, newlyFulfilledWeek } from '../src/utils/entryPatch.js';

let seq = 0;
const run = (person, date, km, extra = {}) =>
  ({ id: `r${++seq}`, person, sport: 'run', runType: 'easy', title: 't', date, km, hasPhoto: false, ts: 1000 + seq, ...extra });

/* ---------- normalisation ---------- */

test('DEFAULT_PLAN_STATE and empty input give the documented defaults', () => {
  const want = { mode: 'calendar', startDate: null, raceDate: null, pauses: [], skipped: [], trainingDays: [], weeklyTarget: null, fallbackStartDate: null };
  assert.deepEqual(DEFAULT_PLAN_STATE, want);
  for (const raw of [undefined, null, 'x', 5, [], {}]) {
    assert.deepEqual(normalizePlanState(raw), { a: want, b: want });
    assert.deepEqual(normalizePersonState(raw), want);
  }
  assert.ok(Object.isFrozen(DEFAULT_PLAN_STATE));
});

test('normalizePlanState keeps valid fields per person and drops invalid ones without throwing', () => {
  const raw = {
    a: {
      mode: 'rolling', startDate: '2026-03-02', raceDate: '2026-09-27',
      pauses: [{ from: '2026-04-01', to: '2026-04-07', note: '  holiday  ' }],
      skipped: ['w7-speed'], trainingDays: [2, 4, 6], weeklyTarget: 4
    },
    b: {
      mode: 'weekly', startDate: '2026-02-30', raceDate: 'soon', pauses: 'no', skipped: [1, null, ''],
      trainingDays: [7, -1, 1.5, 'x', null], weeklyTarget: 0
    }
  };
  const n = normalizePlanState(raw);
  assert.deepEqual(n.a, {
    mode: 'rolling', startDate: '2026-03-02', raceDate: '2026-09-27',
    pauses: [{ from: '2026-04-01', to: '2026-04-07', note: 'holiday' }],
    skipped: ['w7-speed'], trainingDays: [2, 4, 6], weeklyTarget: 4, fallbackStartDate: null
  });
  assert.deepEqual(n.b, DEFAULT_PLAN_STATE);
});

test('normalisation is idempotent and does not mutate its input', () => {
  const raw = { a: { startDate: '2026-03-02', pauses: [{ from: '2026-04-05', to: '2026-04-09' }, { from: '2026-04-01', to: '2026-04-06' }], trainingDays: [6, 2, 2] } };
  const copy = JSON.parse(JSON.stringify(raw));
  const once = normalizePlanState(raw, { settingsStartDate: '2026-01-05' });
  assert.deepEqual(raw, copy);
  assert.deepEqual(normalizePlanState(once, { settingsStartDate: '2026-01-05' }), once);
  assert.deepEqual(normalizePlanState(normalizePlanState(raw)), normalizePlanState(raw));
});

test('settingsStartDate becomes fallbackStartDate (valid dates only), startDate stays the own explicit start', () => {
  const n = normalizePlanState({ a: { startDate: '2026-03-02' } }, { settingsStartDate: '2026-01-05' });
  assert.equal(n.a.startDate, '2026-03-02'); assert.equal(n.a.fallbackStartDate, '2026-01-05');
  assert.equal(n.b.startDate, null); assert.equal(n.b.fallbackStartDate, '2026-01-05');
  assert.equal(normalizePlanState({}, { settingsStartDate: 'garbage' }).a.fallbackStartDate, null);
  // a stored fallbackStartDate in the database is ignored: it only comes from the option
  assert.equal(normalizePlanState({ a: { fallbackStartDate: '2026-01-05' } }).a.fallbackStartDate, null);
});

test('pauses: validated, sorted, overlapping ones merged, adjacent ones kept apart, notes kept', () => {
  const out = normalizePauses([
    { from: '2026-05-10', to: '2026-05-12' },
    { from: '2026-04-10', to: '2026-04-20', note: 'flu' },
    { from: '2026-04-15', to: '2026-04-25' },          // overlaps the flu pause
    { from: '2026-04-26', to: '2026-04-27' },          // adjacent: stays separate
    { from: '2026-06-02', to: '2026-06-01' },          // reversed: dropped
    { from: 'x', to: '2026-06-01' }, null, 'str', { from: '2026-02-30', to: '2026-03-03' }
  ]);
  assert.deepEqual(out, [
    { from: '2026-04-10', to: '2026-04-25', note: 'flu' },
    { from: '2026-04-26', to: '2026-04-27' },
    { from: '2026-05-10', to: '2026-05-12' }
  ]);
  assert.deepEqual(normalizePauses([{ from: '2026-04-01', to: '2026-04-30' }, { from: '2026-04-05', to: '2026-04-06' }]), [{ from: '2026-04-01', to: '2026-04-30' }]);
  assert.equal(normalizePauses([{ from: '2026-04-01', to: '2026-04-02', note: 'x'.repeat(200) }])[0].note.length, 80);
});

test('arrays that the database returns as objects (holes) are accepted', () => {
  const n = normalizePersonState({ trainingDays: { 0: 2, 2: 6 }, skipped: { 1: 'w1-easy' }, pauses: { 1: { from: '2026-04-01', to: '2026-04-02' } } });
  assert.deepEqual(n.trainingDays, [2, 6]);
  assert.deepEqual(n.skipped, ['w1-easy']);
  assert.deepEqual(n.pauses, [{ from: '2026-04-01', to: '2026-04-02' }]);
});

test('trainingDays: 0..6 integers, deduplicated, ascending; weeklyTarget 1..14 integer or null', () => {
  assert.deepEqual(normalizePersonState({ trainingDays: [6, 0, 3, 3, '2', 9, 2.5] }).trainingDays, [0, 2, 3, 6]);
  for (const [raw, want] of [[3, 3], ['4', 4], [14, 14], [15, null], [0, null], [2.5, null], ['', null], [null, null], ['x', null]]) {
    assert.equal(normalizePersonState({ weeklyTarget: raw }).weeklyTarget, want, String(raw));
  }
  assert.deepEqual(normalizePersonState({ skipped: ['a', ' a ', 'b', 'a', 3] }).skipped, ['a', 'b']);
});

test('validatePlanPatch: only provided fields, null clears, invalid input is an error with a message', () => {
  assert.deepEqual(validatePlanPatch({ startDate: '2026-03-02', weeklyTarget: '4', ignored: 1 }), { ok: true, patch: { startDate: '2026-03-02', weeklyTarget: 4 } });
  assert.deepEqual(validatePlanPatch({ startDate: null, raceDate: '', pauses: null, trainingDays: null, skipped: null, weeklyTarget: null }),
    { ok: true, patch: { startDate: null, raceDate: null, pauses: [], trainingDays: [], skipped: [], weeklyTarget: null } });
  assert.deepEqual(validatePlanPatch({ mode: 'rolling', trainingDays: [6, 2, 2] }).patch, { mode: 'rolling', trainingDays: [2, 6] });
  assert.deepEqual(validatePlanPatch({}), { ok: true, patch: {} });
  assert.deepEqual(validatePlanPatch({ pauses: [{ from: '2026-04-09', to: '2026-04-01' }, { from: '2026-03-01', to: '2026-03-03' }] }).ok, false);
  assert.deepEqual(validatePlanPatch({ pauses: [{ from: '2026-04-05', to: '2026-04-09' }, { from: '2026-04-01', to: '2026-04-06' }] }).patch.pauses, [{ from: '2026-04-01', to: '2026-04-09' }]);
  for (const bad of [{ mode: 'x' }, { startDate: '2026-02-30' }, { raceDate: 5 }, { pauses: 'x' }, { pauses: [{}] }, { skipped: [1] },
    { trainingDays: [7] }, { trainingDays: 'x' }, { weeklyTarget: 0 }, { weeklyTarget: 99 }, null, [], 'x']) {
    const r = validatePlanPatch(bad);
    assert.equal(r.ok, false, JSON.stringify(bad));
    assert.ok(typeof r.error === 'string' && r.error);
  }
});

/* ---------- start date and entry week ---------- */

test('effectiveStartFor: own start, else settings, else Monday of the earliest dated run, else this Monday', () => {
  const log = [run('a', '2026-03-12', 5), run('b', '2026-03-04', 5)]; // Wed 12 Mar and Wed 4 Mar
  const today = '2026-03-20';
  const state = normalizePlanState({ a: { startDate: '2026-03-16' } }, { settingsStartDate: '2026-03-09' });
  assert.equal(effectiveStartFor('a', state, log, today), '2026-03-16');   // own
  assert.equal(effectiveStartFor('b', state, log, today), '2026-03-09');   // settings
  const noSettings = normalizePlanState({ a: { startDate: '2026-03-16' } });
  assert.equal(effectiveStartFor('b', noSettings, log, today), '2026-03-02'); // Monday of the earliest dated run (b's, but the whole log counts)
  assert.equal(effectiveStartFor('a', noSettings, [], '2026-03-20'), '2026-03-16'); // own start needs no log
  assert.equal(effectiveStartFor('b', noSettings, [], '2026-03-20'), '2026-03-16'); // this week's Monday (20 Mar is a Friday)
  assert.equal(effectiveStartFor('b', undefined, [], '2026-03-20'), '2026-03-16');
  assert.equal(effectiveStartFor('a', null, log, today), effectiveStartDate(null, log, today));
});

test('effectiveStartFor accepts the { a, b } states, one person\'s state, and raw stored nodes', () => {
  const raw = { a: { startDate: '2026-03-02' }, b: { startDate: '2026-03-09' } };
  assert.equal(effectiveStartFor('a', raw, [], '2026-04-01'), '2026-03-02');
  assert.equal(effectiveStartFor('b', raw, [], '2026-04-01'), '2026-03-09');
  assert.equal(effectiveStartFor('b', raw.b, [], '2026-04-01'), '2026-03-09');
  assert.equal(effectiveStartFor('a', { startDate: 'garbage' }, [], '2026-04-01'), '2026-03-30');
});

test('weekOfEntryFor follows the person\'s start and honours entry.week exactly like weekOfEntry', () => {
  const state = normalizePlanState({ a: { startDate: '2026-03-02' }, b: { startDate: '2026-03-16' } });
  const e = { date: '2026-03-17' };
  assert.equal(weekOfEntryFor('a', e, state, [], '2026-04-01'), 3);
  assert.equal(weekOfEntryFor('b', e, state, [], '2026-04-01'), 1);
  assert.equal(weekOfEntryFor('b', { date: '2026-03-02' }, state, [], '2026-04-01'), -1);
  assert.equal(weekOfEntryFor('a', { date: '2026-03-17', week: 7 }, state, [], '2026-04-01'), 7);
  assert.equal(weekOfEntryFor('a', { date: null, week: 4 }, state, [], '2026-04-01'), 4);
  assert.equal(weekOfEntryFor('a', { date: null }, state, [], '2026-04-01'), null);
  assert.equal(weekOfEntryFor('a', { date: '2026-03-17', week: 0 }, state, [], '2026-04-01'), weekOfEntry({ date: '2026-03-17', week: 0 }, '2026-03-02'));
});

/* ---------- pauses ---------- */

test('isPaused / pausedDaysInWeek / weekIsPaused', () => {
  const st = normalizePlanState({ a: { pauses: [{ from: '2026-03-09', to: '2026-03-15' }, { from: '2026-03-18', to: '2026-03-19' }, { from: '2026-03-23', to: '2026-03-25' }, { from: '2026-03-26', to: '2026-03-29' }] } });
  assert.equal(isPaused(st, '2026-03-09', 'a'), true);
  assert.equal(isPaused(st, '2026-03-15', 'a'), true);
  assert.equal(isPaused(st, '2026-03-16', 'a'), false);
  assert.equal(isPaused(st, '2026-03-09', 'b'), false);
  assert.equal(isPaused(st.a, '2026-03-18'), true);          // one person's state, no person needed
  assert.equal(isPaused(st, '2026-03-09'), false);            // { a, b } without a person
  assert.equal(isPaused(st.a, 'nonsense'), false);
  assert.equal(pausedDaysInWeek(st, '2026-03-09', 'a'), 7);
  assert.equal(pausedDaysInWeek(st, '2026-03-16', 'a'), 2);
  assert.equal(pausedDaysInWeek(st, '2026-03-02', 'a'), 0);
  assert.equal(pausedDaysInWeek(st, '2026-03-23', 'a'), 7);   // two back-to-back ranges cover the week
  assert.equal(weekIsPaused(st, '2026-03-09', 'a'), true);
  assert.equal(weekIsPaused(st, '2026-03-16', 'a'), false);
  assert.equal(weekIsPaused(st, '2026-03-23', 'a'), true);
  assert.equal(weekIsPaused(st, '2026-03-11', 'a'), true);    // a non-Monday date is mapped to its week's Monday
  assert.equal(weekIsPaused(st.a, '2026-03-09'), true);
  assert.equal(weekIsPaused(undefined, '2026-03-09'), false);
});

test('a pause range crossing a DST change still covers whole weeks (date strings only)', () => {
  const st = normalizePlanState({ a: { pauses: [{ from: '2026-03-23', to: '2026-04-05' }] } });
  assert.equal(weekIsPaused(st, '2026-03-23', 'a'), true);
  assert.equal(weekIsPaused(st, '2026-03-30', 'a'), true);
  assert.equal(weekIsPaused(st, '2026-04-06', 'a'), false);
});

/* ---------- template, targets ---------- */

test('getPlanTemplate returns the PLAN constant (code fallback)', () => {
  assert.equal(getPlanTemplate(), PLAN);
  assert.equal(getPlanTemplate('default'), PLAN);
  assert.equal(getPlanTemplate('unknown-id'), PLAN);
});

test('default weekly target = the most common number of runs with a km goal per plan week (3 for the built-in plan)', () => {
  assert.equal(defaultWeeklyTarget(PLAN), 3);
  assert.equal(defaultWeeklyTarget(PLAN, 'a'), 3);
  assert.equal(defaultWeeklyTarget([], 'a'), 3);
  assert.equal(defaultWeeklyTarget(undefined), 3);
  const four = [1, 2, 3].map(n => ({ n, runs: { a: [1, 2, 3, 4].map(i => ({ id: `${n}-${i}`, km: 5 })), b: [{ id: 'x', km: 5 }] } }));
  assert.equal(defaultWeeklyTarget(four, 'a'), 4);
  assert.equal(defaultWeeklyTarget(four, 'b'), 1);
  assert.equal(weeklyTargetFor('a', normalizePlanState({ a: { weeklyTarget: 5 } }), PLAN), 5);
  assert.equal(weeklyTargetFor('b', normalizePlanState({ a: { weeklyTarget: 5 } }), PLAN), 3);
});

/* ---------- golden: buildWeeksFor === buildWeeks when the starts agree ---------- */

// Deterministic pseudo-random fixtures (mulberry32) so a failure is reproducible.
function rng(seed) {
  return () => { seed = (seed + 0x6D2B79F5) | 0; let t = Math.imul(seed ^ (seed >>> 15), 1 | seed); t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t; return ((t ^ (t >>> 14)) >>> 0) / 4294967296; };
}

function randomLog(seed, startISO) {
  const r = rng(seed);
  const log = [];
  const n = Math.floor(r() * 60);
  for (let i = 0; i < n; i++) {
    const person = r() < 0.5 ? 'a' : 'b';
    const roll = r();
    const sport = roll < 0.75 ? 'run' : roll < 0.9 ? 'hike' : 'cycle';
    const e = { id: `g${seed}-${i}`, person, sport, runType: 'easy', title: 't', hasPhoto: false, ts: 100 + i, km: Math.round((2 + r() * 20) * 10) / 10, durationMin: 30 };
    const kind = r();
    if (kind < 0.7) e.date = addDays(startISO, Math.floor(r() * 240) - 20);     // before the start .. after the race
    else if (kind < 0.85) { e.date = null; e.imported = true; e.week = 1 + Math.floor(r() * 32); } // imported, undated
    else { e.date = addDays(startISO, Math.floor(r() * 200)); e.week = 1 + Math.floor(r() * 32); } // override beats the date
    if (r() < 0.05) e.km = 0;
    log.push(e);
  }
  return sortLog(log);
}

test('golden: buildWeeksFor equals buildWeeks for identical per-person state (start from settings) over many fixtures', () => {
  const START = '2026-03-02';
  const goalSets = [{}, { '1-1-0-a': '9', '1-2-1-b': '0', '1-3-2-a': '' }, { '1-30-2-a': '5', '1-5-0-b': '3.5' }];
  const todays = ['2026-02-20', '2026-03-02', '2026-03-05', '2026-03-29', '2026-05-17', '2026-09-27', '2026-09-28', '2027-03-01'];
  const settings = [START, null, '2026-02-23'];
  let checked = 0;
  for (let seed = 1; seed <= 40; seed++) {
    const log = randomLog(seed, START);
    for (const today of todays) {
      for (const s of settings) {
        for (const goals of goalSets) {
          const want = buildWeeks(PLAN, goals, log, effectiveStartDate(s, log, today), today);
          const state = normalizePlanState(null, { settingsStartDate: s });
          for (const viewer of ['a', 'b']) {
            assert.deepEqual(buildWeeksFor({ plan: PLAN, goals, log, state, todayISO: today, viewer }), want, `seed ${seed} today ${today} settings ${s} viewer ${viewer}`);
          }
          // the same thing with explicit per-person starts equal to the settings start
          const start = effectiveStartDate(s, log, today);
          const explicit = normalizePlanState({ a: { startDate: start }, b: { startDate: start } });
          assert.deepEqual(buildWeeksFor({ plan: PLAN, goals, log, state: explicit, todayISO: today }), want);
          checked++;
        }
      }
    }
  }
  assert.equal(checked, 40 * 8 * 3 * 3);
});

test('golden: all week statuses, overrides, imported undated entries, before the start and after the race', () => {
  const START = '2026-03-02';
  const log = sortLog([
    run('a', '2026-03-02', 5), run('a', '2026-03-03', 5), run('a', '2026-03-05', 6.5),   // week 1 fulfilled
    run('a', '2026-03-10', 2),                                                            // week 2 partly done, missed by now
    { id: 'imp1', person: 'a', sport: 'run', runType: 'easy', km: 12, date: null, week: 4, imported: true, ts: 1 }, // undated import
    { id: 'imp2', person: 'b', sport: 'run', runType: 'long', km: 30, date: '2026-03-04', week: 9, ts: 2 },        // override beats the date
    run('a', '2026-02-20', 8),                                                            // before the start: week < 1
    run('b', '2026-12-31', 8),                                                            // after the race
    { id: 'h1', person: 'a', sport: 'hike', km: 10, date: '2026-03-03', ts: 3 },
    run('b', '2026-03-16', 0)
  ]);
  const today = '2026-03-18'; // week 3 is current: missed (2), current (3), upcoming (4+) all appear
  const want = buildWeeks(PLAN, {}, log, START, today);
  const got = buildWeeksFor({ plan: PLAN, goals: {}, log, state: normalizePlanState(null, { settingsStartDate: START }), todayISO: today });
  assert.deepEqual(got, want);
  const statuses = new Set(got.flatMap(w => [w.a.status, w.b.status]));
  for (const s of ['fulfilled', 'missed', 'current', 'upcoming']) assert.ok(statuses.has(s), s);
  assert.equal(got.length, 30);
  assert.equal(got[3].a.entries.some(e => e.id === 'imp1'), true);
  assert.equal(got[8].b.entries.some(e => e.id === 'imp2'), true);
});

test('per-person starts: each person is evaluated against their own start', () => {
  const log = sortLog([
    run('a', '2026-03-17', 5), run('b', '2026-03-17', 5), run('b', '2026-03-18', 5), run('b', '2026-03-20', 6.5),
    run('a', '2026-03-04', 5)
  ]);
  const state = normalizePlanState({ a: { startDate: '2026-03-02' }, b: { startDate: '2026-03-16' } });
  const today = '2026-03-19';
  const weeks = buildWeeksFor({ plan: PLAN, goals: {}, log, state, todayISO: today });
  assert.equal(weeks[2].a.entries.length, 1);                  // a: 17 Mar is plan week 3
  assert.equal(weeks[0].a.entries.length, 1);                  // a: 4 Mar is week 1
  assert.equal(weeks[0].b.entries.length, 3);                  // b: 17-20 Mar is plan week 1
  assert.equal(weeks[0].b.status, 'fulfilled');       // 5 + 5 + 6.5 km of 16.5 planned, in b's week 1
  assert.equal(weeks[0].a.status, 'missed');                   // a's week 1 is long over, b's is running
  assert.equal(weeks[2].a.status, 'current');
  assert.equal(weeks[2].b.status, 'upcoming');
  // top-level fields follow the viewer
  assert.equal(weeks[0].startDate, '2026-03-02'); assert.equal(weeks[0].current, false); // default viewer a
  const asB = buildWeeksFor({ plan: PLAN, goals: {}, log, state, todayISO: today, viewer: 'b' });
  assert.equal(asB[0].startDate, '2026-03-16'); assert.equal(asB[0].current, true); assert.equal(asB[0].endDate, '2026-03-22');
  assert.deepEqual(asB.map(w => w.a), weeks.map(w => w.a));    // per-person data does not depend on the viewer
  assert.deepEqual(asB.map(w => w.b), weeks.map(w => w.b));
  // each person's data equals the single-start reference with their own start
  assert.deepEqual(weeks.map(w => w.a), buildWeeks(PLAN, {}, log, '2026-03-02', today).map(w => w.a));
  assert.deepEqual(weeks.map(w => w.b), buildWeeks(PLAN, {}, log, '2026-03-16', today).map(w => w.b));
});

test('buildWeeksFor without state or log does not throw and uses the automatic start', () => {
  const w = buildWeeksFor({ todayISO: '2026-03-04' });
  assert.equal(w.length, 30); assert.equal(w[0].startDate, '2026-03-02'); assert.equal(w[0].current, true);
});

test('weekWindowsFor: per-person dates, current and over', () => {
  const state = normalizePlanState({ a: { startDate: '2026-03-02' }, b: { startDate: '2026-03-16' } });
  const w = weekWindowsFor({ plan: PLAN, log: [], state, todayISO: '2026-03-19' });
  assert.equal(w.a.length, 30);
  assert.deepEqual(w.a[0], { n: 1, startDate: '2026-03-02', endDate: '2026-03-08', current: false, over: true });
  assert.deepEqual(w.b[0], { n: 1, startDate: '2026-03-16', endDate: '2026-03-22', current: true, over: false });
  assert.equal(currentWeekIndexFor(w, 'a'), 2);
  assert.equal(currentWeekIndexFor(w, 'b'), 0);
  assert.equal(currentWeekIndexFor(weekWindowsFor({ plan: PLAN, log: [], state, todayISO: '2027-12-01' }), 'a'), null);
  assert.equal(currentWeekIndexFor(null, 'a'), null);
});

/* ---------- consumers: recommendForPerson, weekFulfillment ---------- */

test('recommendForPerson without planState equals the old pipeline; with planState each person gets their own week', () => {
  const log = [run('a', '2026-03-03', 5), run('b', '2026-03-03', 5)];
  const base = { person: 'b', log, goals: {}, startDateSetting: '2026-03-02', todayISO: '2026-03-18' };
  const old = recommendForPerson(base);
  assert.deepEqual(recommendForPerson({ ...base, planState: null }), old);
  assert.deepEqual(recommendForPerson({ ...base, planState: {} }), old);
  assert.equal(old.rec.weekNumber, 3);
  // b starts on 16 Mar: 18 Mar is week 1 of b's plan, while a (settings start) is in week 3
  const planState = { b: { startDate: '2026-03-16' } };
  const own = recommendForPerson({ ...base, planState });
  assert.equal(own.rec.weekNumber, 1);
  assert.equal(own.weeks[0].startDate, '2026-03-16');
  assert.equal(recommendForPerson({ ...base, person: 'a', planState }).rec.weekNumber, 3);
  // the raw database form and the normalised form agree
  assert.deepEqual(recommendForPerson({ ...base, planState: normalizePlanState(planState, { settingsStartDate: '2026-03-02' }) }), own);
});

test('weekFulfillment / newlyFulfilledWeek use the person\'s own plan start', () => {
  const l1 = run('b', '2026-03-17', 5), l2 = run('b', '2026-03-18', 5);
  const l3 = run('b', '2026-03-19', 6.5);
  const log = [l1, l2, l3];
  const planState = { b: { startDate: '2026-03-16' } };
  // b's plan starts 16 Mar: week 1 = 5 + 5 + 6.5 km planned 16.5 -> fulfilled
  assert.deepEqual(weekFulfillment({ entry: l3, log, person: 'b', settingsStartDate: '2026-03-02', planState, today: '2026-03-20' }), { n: 1, done: true });
  // under the shared settings start the same run falls in plan week 3
  assert.equal(weekFulfillment({ entry: l3, log, person: 'b', settingsStartDate: '2026-03-02', today: '2026-03-20' }).n, 3);
  assert.equal(weekFulfillment({ entry: run('b', '2026-03-10', 5), log, person: 'b', settingsStartDate: '2026-03-02', planState, today: '2026-03-20' }).n, null); // before b's start
  // editing a short run to 6.5 km completes the week for b under b's start, but not under the shared start
  const edit = run('b', '2026-03-19', 1);
  const afterLog = [l1, l2, edit];
  assert.equal(newlyFulfilledWeek({ entry: edit, next: { ...edit, km: 6.5 }, log: afterLog, settingsStartDate: '2026-03-02', planState, today: '2026-03-20' }), 1);
  assert.equal(newlyFulfilledWeek({ entry: edit, next: { ...edit, km: 6.5 }, log: afterLog, settingsStartDate: '2026-03-02', today: '2026-03-20' }), null);
});
