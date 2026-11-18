import test from 'node:test';
import assert from 'node:assert/strict';
import { PLAN } from '../src/plan.js';
import {
  pointsFor, paceMinPerKm, formatPace, formatDuration, formatKm, weekForDate, effectiveStartDate,
  weekOfEntry, goalKm, buildWeeks, scoreboard, stats, streakDays, weeklyKm, relativeDate,
  mondayOf, addDays, daysBetween, toISODate, isValidISODate, sortLog, defaultTitle, validateActivityInput
} from '../src/scoring.js';

const run = (o = {}) => ({ id: 'x', person: 'a', sport: 'run', runType: 'easy', title: 't', date: '2026-03-02', km: 5, hasPhoto: false, ts: 1, ...o });

test('pointsFor: runs use the run-type multiplier', () => {
  assert.equal(pointsFor(run({ km: 10, runType: 'easy' })), 10);
  assert.equal(pointsFor(run({ km: 10, runType: 'long' })), 13);
  assert.equal(pointsFor(run({ km: 5, runType: 'tempo' })), 8);
  assert.equal(pointsFor(run({ km: 5, runType: 'speed' })), 9);
  assert.equal(pointsFor(run({ km: 3, runType: 'shakeout' })), 3);
  assert.ok(Math.abs(pointsFor(run({ km: 21.1, runType: 'race' })) - 63.3) < 1e-9);
  assert.equal(pointsFor(run({ km: 4, runType: undefined })), 4, 'default easy');
});

test('pointsFor: other sports', () => {
  assert.equal(pointsFor({ sport: 'hike', km: 10 }), 5);
  assert.equal(pointsFor({ sport: 'cycle', durationMin: 60 }), 0.8);
  assert.equal(pointsFor({ sport: 'swim', durationMin: 45 }), 0.9);
  assert.equal(pointsFor({ sport: 'strength', durationMin: 30 }), 0.5);
  assert.ok(Math.abs(pointsFor({ sport: 'workout', durationMin: 90 }) - 1.8) < 1e-9);
});

test('pointsFor: invalid input is 0', () => {
  assert.equal(pointsFor(null), 0);
  assert.equal(pointsFor({ sport: 'nope', km: 5 }), 0);
  assert.equal(pointsFor({ sport: 'run' }), 0);
  assert.equal(pointsFor({ sport: 'swim', km: 5 }), 0);
  assert.equal(pointsFor({ sport: 'hike', km: -2 }), 0);
});

test('pace and formatting', () => {
  assert.equal(paceMinPerKm({ km: 10, durationMin: 55 }), 5.5);
  assert.equal(paceMinPerKm({ km: 10 }), null);
  assert.equal(paceMinPerKm({ durationMin: 30 }), null);
  assert.equal(formatPace(5.5), '5:30');
  assert.equal(formatPace(5.9999), '6:00');
  assert.equal(formatPace(4 + 5 / 60), '4:05');
  assert.equal(formatPace(null), '–');
  assert.equal(formatDuration(45), '45 min');
  assert.equal(formatDuration(65), '1 h 05 min');
  assert.equal(formatDuration(120), '2 h');
  assert.equal(formatDuration(0), '–');
  assert.equal(formatKm(8.2), '8.2');
  assert.equal(formatKm(10), '10');
  assert.equal(formatKm(0.04), '0');
});

test('date helpers', () => {
  assert.equal(mondayOf('2026-03-02'), '2026-03-02'); // Monday
  assert.equal(mondayOf('2026-03-08'), '2026-03-02'); // Sunday
  assert.equal(mondayOf('2026-03-04'), '2026-03-02');
  assert.equal(addDays('2026-02-27', 3), '2026-03-02');
  assert.equal(addDays('2026-01-01', -1), '2025-12-31');
  assert.equal(daysBetween('2026-03-28', '2026-03-30'), 2); // across EU DST switch
  assert.equal(daysBetween('2026-10-24', '2026-10-26'), 2); // across end of DST
  assert.equal(toISODate(new Date(2026, 2, 5, 23, 59)), '2026-03-05');
  assert.ok(isValidISODate('2026-02-28'));
  assert.ok(!isValidISODate('2026-02-30'));
  assert.ok(!isValidISODate('26-02-28'));
});

test('weekForDate', () => {
  const start = '2026-03-02';
  assert.equal(weekForDate(start, '2026-03-02'), 1);
  assert.equal(weekForDate(start, '2026-03-08'), 1);
  assert.equal(weekForDate(start, '2026-03-09'), 2);
  assert.equal(weekForDate(start, '2026-02-28'), 0);
  assert.equal(weekForDate(start, '2026-09-27'), 30);
  assert.equal(weekForDate(start, '2026-09-28'), 31);
  // DST: Sunday 2026-03-29 is still week 4
  assert.equal(weekForDate(start, '2026-03-29'), 4);
  assert.equal(weekForDate(start, '2026-03-30'), 5);
});

test('effectiveStartDate', () => {
  assert.equal(effectiveStartDate('2026-04-01', [run()], '2026-05-01'), '2026-04-01');
  const log = [run({ date: '2026-03-12' }), run({ date: '2026-03-05' }), run({ sport: 'swim', date: '2026-02-01' }), run({ date: null })];
  assert.equal(effectiveStartDate(null, log, '2026-05-01'), '2026-03-02');
  assert.equal(effectiveStartDate(null, [], '2026-05-07'), '2026-05-04');
  assert.equal(effectiveStartDate('garbage', [], '2026-05-07'), '2026-05-04');
});

test('weekOfEntry: override beats date, null date without override is unmapped', () => {
  assert.equal(weekOfEntry(run({ date: '2026-03-10' }), '2026-03-02'), 2);
  assert.equal(weekOfEntry(run({ date: '2026-03-10', week: 7 }), '2026-03-02'), 7);
  assert.equal(weekOfEntry(run({ date: null, week: 3 }), '2026-03-02'), 3);
  assert.equal(weekOfEntry(run({ date: null }), '2026-03-02'), null);
});

test('goalKm overrides', () => {
  const r = { id: 'r1', km: 5 };
  assert.equal(goalKm(r, {}), 5);
  assert.equal(goalKm(r, { r1: '' }), 5, 'empty override uses default');
  assert.equal(goalKm(r, { r1: '7.5' }), 7.5);
  assert.equal(goalKm(r, { r1: '0' }), 0);
  assert.equal(goalKm(r, { r1: 'abc' }), 5);
  assert.equal(goalKm({ id: 'r2', km: null }, {}), 0);
  assert.equal(goalKm({ id: 'r2', km: null }, { r2: '4' }), 4);
});

test('buildWeeks: statuses and pct', () => {
  const start = '2026-03-02';
  const today = '2026-03-18'; // week 3
  const log = [
    run({ id: '1', km: 5, date: '2026-03-03' }), // week 1
    run({ id: '2', km: 5, date: '2026-03-04' }),
    run({ id: '3', km: 6.5, date: '2026-03-08' }), // week 1 now 16.5 -> fulfilled
    run({ id: '4', km: 5, date: '2026-03-10' }), // week 2: 5/16.5
    run({ id: '5', km: 8, date: '2026-03-17', person: 'b' }), // week 3 for b
    { ...run({ id: '6', sport: 'hike', km: 20, date: '2026-03-03' }) } // hikes never count for plan km
  ];
  const w = buildWeeks(PLAN, {}, log, start, today);
  assert.equal(w.length, 30);
  assert.equal(w[0].a.plannedKm, 16.5);
  assert.equal(w[0].a.doneKm, 16.5);
  assert.equal(w[0].a.pct, 100);
  assert.equal(w[0].a.status, 'fulfilled');
  assert.equal(w[0].b.status, 'missed');
  assert.equal(w[0].b.pct, 0);
  assert.equal(w[1].a.pct, 30);
  assert.equal(w[1].a.status, 'missed');
  assert.equal(w[2].current, true);
  assert.equal(w[2].b.status, 'current');
  assert.equal(w[2].b.pct, Math.round(100 * 8 / 19));
  assert.equal(w[3].a.status, 'upcoming');
  assert.equal(w[0].startDate, '2026-03-02');
  assert.equal(w[0].endDate, '2026-03-08');
  assert.equal(w[0].a.entries.length, 4 - 0, 'week 1 entries incl. hike');
  assert.equal(w.filter(x => x.current).length, 1);
});

test('buildWeeks: pct never shows 100 below plan, overshoot is capped', () => {
  const start = '2026-03-02';
  const log = [run({ km: 16.4, date: '2026-03-03' })];
  const w1 = buildWeeks(PLAN, {}, log, start, '2026-03-04');
  assert.equal(w1[0].a.pct, 99);
  assert.equal(w1[0].a.status, 'current');
  const w2 = buildWeeks(PLAN, {}, [run({ km: 40, date: '2026-03-03' })], start, '2026-03-04');
  assert.equal(w2[0].a.pct, 100);
  assert.equal(w2[0].a.doneKm, 40);
});

test('buildWeeks: goal overrides change planned km; n/a when planned is 0; imported week override', () => {
  const start = '2026-03-02';
  const goals = { '1-1-0-a': '10', '1-1-1-a': '0', '1-1-2-a': '' };
  const imported = run({ date: null, week: 1, km: 10, imported: true });
  const w = buildWeeks(PLAN, goals, [imported], start, '2026-03-04');
  assert.equal(w[0].a.plannedKm, 10 + 0 + 6.5);
  assert.equal(w[0].a.runs[0].km, 10);
  assert.equal(w[0].a.runs[0].defaultKm, 5);
  assert.equal(w[0].a.doneKm, 10);
  const zero = buildWeeks(PLAN, { '1-1-0-a': '0', '1-1-1-a': '0', '1-1-2-a': '0' }, [], start, '2026-03-04');
  assert.equal(zero[0].a.status, 'n/a');
  assert.equal(zero[0].a.pct, null);
});

test('buildWeeks: before the start everything is upcoming; after the plan everything missed', () => {
  const w = buildWeeks(PLAN, {}, [], '2026-03-02', '2026-02-20');
  assert.ok(w.every(x => x.a.status === 'upcoming' && !x.current));
  const w2 = buildWeeks(PLAN, {}, [], '2026-03-02', '2027-01-01');
  assert.ok(w2.every(x => x.a.status === 'missed' && !x.current));
});

test('streakDays', () => {
  const e = d => run({ date: d });
  assert.equal(streakDays([], '2026-03-10'), 0);
  assert.equal(streakDays([e('2026-03-10')], '2026-03-10'), 1);
  assert.equal(streakDays([e('2026-03-09'), e('2026-03-08')], '2026-03-10'), 2, 'ends yesterday');
  assert.equal(streakDays([e('2026-03-08')], '2026-03-10'), 0, 'gap yesterday');
  assert.equal(streakDays([e('2026-03-10'), e('2026-03-10'), e('2026-03-09'), e('2026-03-07')], '2026-03-10'), 2);
  assert.equal(streakDays([run({ date: null, week: 2 })], '2026-03-10'), 0, 'imported does not count');
  assert.equal(streakDays([e('2026-03-12')], '2026-03-10'), 0, 'future is ignored');
  assert.equal(streakDays([e('2026-02-28'), e('2026-03-01'), e('2026-03-02')], '2026-03-02'), 3, 'month boundary');
});

test('weeklyKm: 8 Monday-based weeks, oldest first', () => {
  const today = '2026-03-18'; // Wed, Monday 2026-03-16
  const es = [
    run({ date: '2026-03-16', km: 5 }), run({ date: '2026-03-18', km: 3 }),
    run({ date: '2026-03-15', km: 10 }), // previous Sunday
    { ...run({ date: '2026-03-10' }), sport: 'hike', km: 12 },
    run({ date: '2026-03-11', sport: 'swim', km: undefined, durationMin: 30 }),
    run({ date: '2025-01-01', km: 99 }), // out of range
    run({ date: null, km: 50, week: 2 })
  ];
  const w = weeklyKm(es, today);
  assert.equal(w.length, 8);
  assert.equal(w[7].weekStart, '2026-03-16');
  assert.equal(w[0].weekStart, '2026-01-26');
  assert.equal(w[7].km, 8);
  assert.equal(w[6].km, 22);
  assert.equal(w.slice(0, 6).reduce((s, x) => s + x.km, 0), 0);
});

test('stats: longest run, best pace (runs >= 1 km with duration), totals', () => {
  const log = [
    run({ id: '1', km: 10, durationMin: 55, date: '2026-03-10' }),   // 5.5
    run({ id: '2', km: 0.5, durationMin: 2, date: '2026-03-10' }),   // too short for pace
    run({ id: '3', km: 21.1, durationMin: 120, date: '2026-03-09', runType: 'long' }), // 5.68
    run({ id: '4', km: 5, date: null, week: 1, imported: true }),
    run({ id: '5', person: 'b', km: 8, durationMin: 36, date: '2026-03-10' }),
    { ...run({ id: '6', sport: 'hike' }), km: 12, durationMin: 60, date: '2026-03-08' }
  ];
  const s = stats(log, '2026-03-10');
  assert.equal(s.a.count, 5);
  assert.equal(s.a.longestRunKm, 21.1);
  assert.equal(s.a.bestPaceMinPerKm, 5.5);
  assert.equal(s.a.totalKm, 10 + 0.5 + 21.1 + 5 + 12);
  assert.equal(s.a.streakDays, 3);
  assert.equal(s.b.bestPaceMinPerKm, 4.5);
  assert.equal(s.b.longestRunKm, 8);
  assert.equal(s.b.weeklyKm.length, 8);
  const none = stats([], '2026-03-10');
  assert.equal(none.a.bestPaceMinPerKm, null);
  assert.equal(none.a.longestRunKm, 0);
});

test('scoreboard', () => {
  const start = '2026-03-02';
  const log = [
    run({ id: '1', km: 10, runType: 'long', date: '2026-03-03' }),
    { ...run({ id: '2', sport: 'swim', km: undefined }), durationMin: 60, date: '2026-03-04' },
    run({ id: '3', person: 'b', km: 6.5, date: '2026-03-04' })
  ];
  const weeks = buildWeeks(PLAN, {}, log, start, '2026-03-04');
  const sb = scoreboard(log, weeks, '2026-03-04');
  assert.equal(sb.a.points, 13 + 1.2);
  assert.equal(sb.a.km, 10);
  assert.equal(sb.a.runKm, 10);
  assert.equal(sb.a.count, 2);
  assert.equal(sb.a.streak, 2);
  const planned = PLAN.reduce((s, w) => s + w.runs.a.reduce((x, r) => x + (r.km || 0), 0), 0);
  assert.equal(sb.a.planPct, Math.round(100 * 10 / planned));
  assert.equal(sb.b.points, 6.5);
  assert.equal(sb.b.streak, 1);
});

test('relativeDate', () => {
  const t = '2026-03-18';
  assert.equal(relativeDate('2026-03-18', t), 'Today');
  assert.equal(relativeDate('2026-03-17', t), 'Yesterday');
  assert.equal(relativeDate('2026-03-19', t), 'Tomorrow');
  assert.equal(relativeDate('2026-03-15', t), 'Sunday');
  assert.equal(relativeDate('2026-03-12', t), 'Thursday');
  assert.equal(relativeDate('2026-03-11', t), '11 Mar');
  assert.equal(relativeDate('2025-12-24', t), '24 Dec 2025');
  assert.equal(relativeDate(null, t), '');
});

test('sortLog: newest first, null dates last', () => {
  const l = [run({ id: 'a', date: '2026-03-01', ts: 5 }), run({ id: 'b', date: null, ts: 99 }), run({ id: 'c', date: '2026-03-02', ts: 1 }), run({ id: 'd', date: '2026-03-01', ts: 9 })];
  assert.deepEqual(sortLog(l).map(e => e.id), ['c', 'd', 'a', 'b']);
});

test('defaultTitle', () => {
  assert.equal(defaultTitle('run', new Date(2026, 2, 1, 7)), 'Morning run');
  assert.equal(defaultTitle('cycle', new Date(2026, 2, 1, 14)), 'Afternoon ride');
  assert.equal(defaultTitle('swim', new Date(2026, 2, 1, 19)), 'Evening swim');
  assert.equal(defaultTitle('workout', new Date(2026, 2, 1, 23)), 'Night workout');
});

test('validateActivityInput', () => {
  const now = new Date(2026, 2, 1, 7);
  const ok = validateActivityInput({ sport: 'run', date: '2026-03-01', km: '8,2', durationMin: '45', runType: 'tempo', note: ' hi ' }, now);
  assert.deepEqual(ok, { ok: true, value: { sport: 'run', title: 'Morning run', date: '2026-03-01', runType: 'tempo', km: 8.2, durationMin: 45, note: 'hi' } });
  assert.equal(validateActivityInput({ sport: 'run', date: '2026-03-01' }).ok, false);
  assert.equal(validateActivityInput({ sport: 'run', date: '2026-03-01', km: '0' }).ok, false);
  assert.equal(validateActivityInput({ sport: 'swim', date: '2026-03-01', km: 2 }).ok, false, 'swim needs minutes');
  assert.equal(validateActivityInput({ sport: 'swim', date: '2026-03-01', durationMin: 30 }).ok, true);
  assert.equal(validateActivityInput({ sport: 'swim', date: '2026-03-01', durationMin: 30, km: 5 }).value.km, undefined, 'km dropped for min-sports');
  assert.equal(validateActivityInput({ sport: 'hike', date: '2026-03-01', km: 5 }).ok, true);
  assert.equal(validateActivityInput({ sport: 'dance', date: '2026-03-01', km: 5 }).ok, false);
  assert.equal(validateActivityInput({ sport: 'run', date: '2026-13-01', km: 5 }).ok, false);
  assert.equal(validateActivityInput({ sport: 'run', date: '2026-03-01', km: 5, runType: 'bogus' }).value.runType, 'easy');
  assert.equal(validateActivityInput({ sport: 'run', date: '2026-03-01', km: 5, title: '  Park loop ' }).value.title, 'Park loop');
});
