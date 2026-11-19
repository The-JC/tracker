import test from 'node:test';
import assert from 'node:assert/strict';
import { PLAN } from '../src/plan.js';
import { addDays, mondayOf } from '../src/scoring.js';
import { normalizePlanState, weekStreak } from '../src/planModel.js';
import { weekStreakText, thisWeekRunsText } from '../src/viewmodels.js';

// Dates are strings and all arithmetic is UTC based, so the zone must not matter. Prove it in the zone with DST changes.
process.env.TZ = 'Europe/Zurich';

let seq = 0;
const run = (date, extra = {}) => ({ id: `s${++seq}`, person: 'a', sport: 'run', runType: 'easy', title: 't', date, km: 5, hasPhoto: false, ts: 1000 + seq, ...extra });
// n runs inside the week starting `monday` (one per day from Monday on)
const week = (monday, n = 3, extra = {}) => Array.from({ length: n }, (_, i) => run(addDays(monday, i * 2 > 6 ? 6 : i * 2), extra));
const START = '2026-03-02'; // a Monday
const state = (a = {}, settingsStartDate = START) => normalizePlanState({ a }, { settingsStartDate });
const streak = (log, today, a = {}, opts = {}) => weekStreak({ log, person: 'a', state: state(a, opts.settingsStartDate === undefined ? START : opts.settingsStartDate), plan: PLAN, todayISO: today });
const W = n => addDays(START, (n - 1) * 7); // Monday of plan week n

test('no runs: nothing counts, the target is the plan default', () => {
  assert.deepEqual(streak([], '2026-03-18'), { current: 0, best: 0, thisWeek: { runs: 0, target: 3, met: false, paused: false }, target: 3 });
  assert.deepEqual(weekStreak({ log: undefined, person: 'a', todayISO: '2026-03-18' }).current, 0);
});

test('weeks met in a row count; the week in progress does not break the streak while unmet', () => {
  const log = [...week(W(1)), ...week(W(2)), run(W(3))];
  const r = streak(log, addDays(W(3), 2)); // Wednesday of week 3, one run so far
  assert.equal(r.current, 2); assert.equal(r.best, 2);
  assert.deepEqual(r.thisWeek, { runs: 1, target: 3, met: false, paused: false });
});

test('the week in progress counts as soon as it is met', () => {
  const log = [...week(W(1)), ...week(W(2)), ...week(W(3))];
  const r = streak(log, addDays(W(3), 4)); // Friday, 3 runs done (Mon, Wed, Fri)
  assert.equal(r.current, 3);
  assert.equal(r.thisWeek.met, true); assert.equal(r.thisWeek.runs, 3);
});

test('a finished week below the target breaks the streak; best keeps the longest one', () => {
  const log = [...week(W(1)), ...week(W(2)), ...week(W(3)), ...week(W(4), 2), ...week(W(5)), ...week(W(6))];
  const r = streak(log, addDays(W(6), 6)); // Sunday of week 6, finished
  assert.equal(r.current, 2); assert.equal(r.best, 3);
  // on the Monday of week 7 (no run yet) the streak is intact: week 7 is in progress
  const mon = streak(log, W(7));
  assert.equal(mon.current, 2); assert.equal(mon.thisWeek.runs, 0);
  // once week 7 is over without runs the streak is gone, best stays
  const gone = streak(log, W(8));
  assert.equal(gone.current, 0); assert.equal(gone.best, 3);
});

test('a missed first finished week gives no streak; a week with the exact target counts, one run less does not', () => {
  assert.equal(streak(week(W(1), 2), W(2)).current, 0);
  assert.equal(streak(week(W(1), 3), W(2)).current, 1);
  assert.equal(streak(week(W(1), 5), W(2)).current, 1); // more than the target is fine, still one week
});

test('only dated runs with km > 0 of this person count; other sports, zero km and other people do not', () => {
  const log = [
    run(W(1)), run(W(1), { sport: 'hike' }), run(W(1), { km: 0 }), run(W(1), { km: null }), run(W(1), { sport: 'cycle', durationMin: 60, km: undefined }),
    run(W(1), { person: 'b' }), run(W(1)), run(W(1), { date: null }) // undated without week: ignored
  ];
  assert.equal(streak(log, W(2)).current, 0); // only 2 valid runs
  assert.equal(streak([...log, run(W(1))], W(2)).current, 1);
});

test('two runs on the same day count as two runs', () => {
  const d = addDays(W(1), 1);
  assert.equal(streak([run(d), run(d), run(d)], W(2)).current, 1);
});

test('Sunday and the following Monday belong to different weeks', () => {
  const sun = addDays(W(1), 6), mon = W(2);
  const log = [run(W(1)), run(addDays(W(1), 2)), run(sun), run(mon), run(addDays(mon, 1))];
  assert.equal(streak(log, addDays(W(2), 6)).current, 1);   // week 2 only has 2 runs
  assert.equal(streak([...log, run(addDays(mon, 3))], addDays(W(2), 6)).current, 2);
});

test('weeklyTarget in the plan state overrides the plan default', () => {
  const log = [...week(W(1), 2), ...week(W(2), 2)];
  assert.equal(streak(log, W(3)).current, 0);
  const r = streak(log, W(3), { weeklyTarget: 2 });
  assert.equal(r.current, 2); assert.equal(r.target, 2); assert.equal(r.thisWeek.target, 2);
  assert.equal(streak(week(W(1), 3), W(2), { weeklyTarget: 4 }).current, 1); // capped by the 3 planned runs of a plan week
});

test('a week fully inside a pause is skipped: it neither counts nor breaks', () => {
  const log = [...week(W(1)), ...week(W(3))];
  const paused = { pauses: [{ from: W(2), to: addDays(W(2), 6) }] };
  assert.equal(streak(log, W(4), paused).current, 2);       // 1 and 3, 2 is skipped
  assert.equal(streak(log, W(4)).current, 1);               // without the pause week 2 breaks it, only week 3 counts
  // pauses made of several back-to-back ranges also cover the week
  const split = { pauses: [{ from: W(2), to: addDays(W(2), 2) }, { from: addDays(W(2), 3), to: addDays(W(2), 6) }] };
  assert.equal(streak(log, W(4), split).current, 2);
});

test('a pause does not make weeks count: best and current only grow with met weeks', () => {
  const r = streak(week(W(1)), addDays(W(6), 3), { pauses: [{ from: W(2), to: addDays(W(5), 6) }] });
  assert.equal(r.current, 1); assert.equal(r.best, 1);
});

test('a partly paused week counts when met and is skipped (not broken) when not met', () => {
  const partial = { pauses: [{ from: addDays(W(2), 2), to: addDays(W(2), 3) }] }; // Wed-Thu
  assert.equal(streak([...week(W(1)), run(W(2)), ...week(W(3))], W(4), partial).current, 2);
  assert.equal(streak([...week(W(1)), ...week(W(2)), ...week(W(3))], W(4), partial).current, 3);
  // without the pause that short week 2 breaks the streak
  assert.equal(streak([...week(W(1)), run(W(2)), ...week(W(3))], W(4)).current, 1);
});

test('the current week being paused: reported as paused, never breaks', () => {
  const paused = { pauses: [{ from: W(3), to: addDays(W(3), 6) }] };
  const r = streak([...week(W(1)), ...week(W(2))], addDays(W(3), 2), paused);
  assert.equal(r.current, 2); assert.equal(r.thisWeek.paused, true); assert.equal(r.thisWeek.met, false);
});

test('weeks before the person\'s start are ignored; the calendar week of the start counts', () => {
  // explicit start on Monday 9 Mar: runs of the week of 2 Mar do not exist for the streak
  const log = [...week(W(1)), ...week(W(2))];
  const own = { startDate: W(2) };
  const r = streak(log, addDays(W(2), 6), own);
  assert.equal(r.current, 1); assert.equal(r.best, 1);
  // a Wednesday start: the Monday-Sunday week containing it is the first week
  const wed = addDays(W(2), 2);
  assert.equal(streak([run(wed), run(addDays(wed, 1)), run(addDays(wed, 2))], W(3), { startDate: wed }).current, 1);
  // runs in the week before the start's week are ignored
  assert.equal(streak([...week(W(1)), ...week(W(2))], W(3), { startDate: wed }).best, 1);
  // today before the plan starts: all zero, target still reported
  const before = streak(week(W(1)), '2026-02-20', { startDate: W(4) });
  assert.deepEqual(before, { current: 0, best: 0, thisWeek: { runs: 0, target: 3, met: false, paused: false }, target: 3 });
});

test('each person has their own start: the same log gives different streaks', () => {
  const log = [...week(W(1)), ...week(W(2)), ...week(W(3))];
  const st = normalizePlanState({ a: { startDate: W(1) }, b: { startDate: W(3) } });
  const asB = log.map(e => ({ ...e, person: 'b' }));
  const a = weekStreak({ log, person: 'a', state: st, plan: PLAN, todayISO: addDays(W(3), 6) });
  const b = weekStreak({ log: asB, person: 'b', state: st, plan: PLAN, todayISO: addDays(W(3), 6) });
  assert.equal(a.current, 3); assert.equal(b.current, 1);
});

test('undated imported entries use their week override, mapped to that plan week through the person\'s start', () => {
  const imp = (w, extra = {}) => ({ id: `i${++seq}`, person: 'a', sport: 'run', runType: 'easy', km: 5, date: null, week: w, imported: true, ts: 1, ...extra });
  const log = [imp(1), imp(1), imp(1), imp(2), imp(2), imp(2), imp(3)];
  const r = streak(log, addDays(W(3), 2));
  assert.equal(r.current, 2); assert.equal(r.thisWeek.runs, 1);
  // with an own start two weeks later the same week numbers land two weeks later
  const shifted = streak(log, addDays(W(5), 2), { startDate: W(3) });
  assert.equal(shifted.current, 2); assert.equal(shifted.thisWeek.runs, 1);
  // a week override outside the weeks seen so far, or junk, is ignored
  assert.equal(streak([imp(99), imp(0), imp(-1), imp('x')], W(3)).current, 0);
  assert.equal(streak([imp(1), imp(1), imp(1)], W(2)).current, 1);
  // a dated entry uses its date even when it carries a week override
  assert.equal(streak([run(W(1), { week: 9 }), run(W(1), { week: 9 }), run(W(1), { week: 9 })], W(2)).current, 1);
});

test('runs dated after today are ignored', () => {
  const log = [...week(W(1)), run(addDays(W(2), 5)), run(addDays(W(2), 6)), run(W(3))];
  const r = streak(log, addDays(W(2), 1)); // Tuesday of week 2: the Sat/Sun runs are in the future
  assert.equal(r.thisWeek.runs, 0); assert.equal(r.current, 1);
});

test('automatic start: without any start the first dated run\'s week is the first week', () => {
  const log = [...week(W(1)), ...week(W(2))];
  const r = weekStreak({ log, person: 'a', state: normalizePlanState(null), plan: PLAN, todayISO: addDays(W(2), 6) });
  assert.equal(r.current, 2);
});

test('DST weeks in Europe/Zurich (29 Mar and 25 Oct 2026) are ordinary weeks', () => {
  // spring forward: Sunday 29 Mar belongs to the week of Monday 23 Mar, Monday 30 Mar starts the next one
  const st = { settingsStartDate: '2026-03-16' };
  const log = [
    run('2026-03-16'), run('2026-03-18'), run('2026-03-20'),
    run('2026-03-23'), run('2026-03-26'), run('2026-03-29'),          // Sunday of the 23-hour... 23-hour day
    run('2026-03-30'), run('2026-04-01'), run('2026-04-03')
  ];
  const r = streak(log, '2026-04-05', {}, st);
  assert.equal(r.current, 3);
  assert.deepEqual([r.thisWeek.runs, r.thisWeek.met], [3, true]);
  // Sunday run moved to the Monday: week of 23 Mar has 2 runs and breaks, only the last week counts
  const moved = log.map(e => (e.date === '2026-03-29' ? { ...e, date: '2026-03-30' } : e));
  const m = streak(moved, '2026-04-05', {}, st);
  assert.equal(m.current, 1); assert.equal(m.best, 1);
  // fall back: Sunday 25 Oct is a 25-hour day in the week of 19 Oct
  const fall = [run('2026-10-19'), run('2026-10-21'), run('2026-10-25'), run('2026-10-26'), run('2026-10-28'), run('2026-11-01')];
  const f = streak(fall, '2026-11-01', {}, { settingsStartDate: '2026-10-19' });
  assert.equal(f.current, 2);
  // the check is date based: the result is the same for any "today" within the Sunday
  assert.equal(streak(fall, '2026-10-25', {}, { settingsStartDate: '2026-10-19' }).current, 1);
});

test('year boundary: the week of 29 Dec 2025 - 4 Jan 2026 is one week', () => {
  const st = { settingsStartDate: '2025-12-15' };
  const log = [
    run('2025-12-15'), run('2025-12-17'), run('2025-12-19'),
    run('2025-12-30'), run('2026-01-01'), run('2026-01-04'),          // Tue, Thu (New Year), Sun
    run('2026-01-05'), run('2026-01-07'), run('2026-01-09')
  ];
  // the week of 22 Dec has no runs: it breaks the first streak, the following two weeks count
  const r = streak(log, '2026-01-11', {}, st);
  assert.equal(r.current, 2); assert.equal(r.best, 2);
  // fill the missing week: all four count
  const filled = [...log, ...week('2025-12-22')];
  assert.equal(streak(filled, '2026-01-11', {}, st).current, 4);
  // a run on Sunday 4 Jan and one on Monday 5 Jan are different weeks
  assert.equal(mondayOf('2026-01-04'), '2025-12-29'); assert.equal(mondayOf('2026-01-05'), '2026-01-05');
});

test('race week: exactly the planned runs keep the streak (target is per plan week)', () => {
  const all = Array.from({ length: 30 }, (_, i) => week(W(i + 1))).flat();
  const raceDay = addDays(W(30), 6);
  assert.equal(streak(all, raceDay).current, 30);
  // the race week with the two planned runs only (easy 4 km + race), no optional shakeout
  const two = [...Array.from({ length: 29 }, (_, i) => week(W(i + 1))).flat(), run(W(30)), run(raceDay)];
  for (const today of [raceDay, addDays(raceDay, 1), addDays(raceDay, 3)]) { // week 31 is in progress and never breaks it
    const r = streak(two, today);
    assert.equal(r.current, 30, today); assert.equal(r.best, 30);
  }
  const rw = streak(two, raceDay);
  assert.deepEqual(rw.thisWeek, { runs: 2, target: 2, met: true, paused: false }); assert.equal(rw.target, 3);
  // one run is not enough even in the race week
  assert.equal(streak([...two.slice(0, -2), run(raceDay)], addDays(raceDay, 3)).current, 0);
  // the week after the plan uses the configured target
  assert.equal(streak(two, addDays(raceDay, 2)).thisWeek.target, 3);
});

test('per-week target: user target stays when lower, is capped by the plan when higher, goal overrides and skipped sessions count', () => {
  const two = week(W(1), 2);
  assert.equal(streak(two, W(2), { weeklyTarget: 2 }).current, 1);
  assert.equal(streak(two, W(2), { weeklyTarget: 2 }).thisWeek.target, 2);
  assert.equal(streak(two, W(2), { weeklyTarget: 5 }).current, 0);          // capped at 3 planned, 2 runs are not enough
  assert.equal(streak(week(W(1), 3), W(2), { weeklyTarget: 5 }).current, 1);
  assert.equal(streak(week(W(1), 3), W(2), { weeklyTarget: 5 }).thisWeek.target, 3);
  // a goal override of 0 removes a planned run; a skipped session too (by run id or w<week>-<type>)
  const goals = { '1-1-1-a': '0' };
  assert.equal(weekStreak({ log: two, person: 'a', state: state(), plan: PLAN, goals, todayISO: W(2) }).current, 1);
  assert.equal(streak(two, W(2), { skipped: ['w1-tempo'] }).current, 1);
  assert.equal(streak(two, W(2), { skipped: ['1-1-1-a'] }).current, 1);
  // rolling mode does not map calendar weeks to plan weeks: the configured target applies
  assert.equal(streak(two, W(2), { mode: 'rolling' }).current, 0);
  // weeks outside the plan (after week 30) use the configured target
  assert.equal(streak([], addDays(W(31), 3)).thisWeek.target, 3);
  assert.equal(streak([], addDays(W(31), 3), { weeklyTarget: 5 }).thisWeek.target, 5);
});

test('best is never below current and survives a break', () => {
  const log = [...week(W(1)), ...week(W(2)), ...week(W(3)), ...week(W(4), 1), ...week(W(5))];
  const r = streak(log, addDays(W(5), 4)); // Friday: Mon, Wed, Fri runs are in
  assert.equal(r.current, 1); assert.equal(r.best, 3);
  assert.ok(r.best >= r.current);
});

test('invalid input does not throw', () => {
  assert.equal(weekStreak({ log: [null, 'x', {}], person: 'a', todayISO: '2026-03-18' }).current, 0);
  assert.equal(weekStreak({ log: [], person: 'c', todayISO: '2026-03-18' }).current, 0);
  assert.equal(weekStreak({ log: [], person: 'a', todayISO: 'nope' }).current, 0);
  assert.equal(weekStreak().current, 0);
  assert.equal(weekStreak({ log: [], person: 'a', state: 'garbage', plan: [], todayISO: '2026-03-18' }).target, 3);
});

test('the streak accepts raw database nodes, normalised states and one person\'s state', () => {
  const log = [...week(W(1)), ...week(W(2))];
  const today = W(3);
  const want = 2;
  assert.equal(weekStreak({ log, person: 'a', state: { a: { startDate: W(1) } }, todayISO: today }).current, want);
  assert.equal(weekStreak({ log, person: 'a', state: normalizePlanState({ a: { startDate: W(1) } }), todayISO: today }).current, want);
  assert.equal(weekStreak({ log, person: 'a', state: normalizePlanState({ a: { startDate: W(1) } }).a, todayISO: today }).current, want);
});

test('view texts', () => {
  assert.equal(weekStreakText(0), 'No week streak yet');
  assert.equal(weekStreakText(1), '1 week streak');
  assert.equal(weekStreakText(4), '4 week streak');
  assert.equal(weekStreakText(undefined), 'No week streak yet');
  assert.equal(thisWeekRunsText({ runs: 2, target: 3, met: false, paused: false }), 'This week 2 of 3 runs');
  assert.equal(thisWeekRunsText({ runs: 1, target: 1, met: true, paused: false }), 'This week 1 of 1 run');
  assert.equal(thisWeekRunsText({ runs: 0, target: 3, met: false, paused: true }), 'This week is paused');
  assert.equal(thisWeekRunsText(null), '');
});
