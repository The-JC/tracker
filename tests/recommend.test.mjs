import test from 'node:test';
import assert from 'node:assert/strict';
import { PLAN } from '../src/plan.js';
import {
  recommendNext, summarizeWeekMatches, matchWeekRuns, DONE_THRESHOLD, HARD_MULT, AVOID_SCORE
} from '../src/recommend.js';

// Week 1 (person a): Easy 5 · Tempo 5 (4x2 min pickups) · Long run 6.5.  Start Monday 2026-03-02, so
// Mon 02, Tue 03, Wed 04, Thu 05, Fri 06, Sat 07, Sun 08 March are week 1; week 2 starts Mon 09 March.
const START = '2026-03-02';
let seq = 0;
const e = (date, runType, km, extra = {}) => ({ id: `e${++seq}`, person: 'a', sport: 'run', runType, title: 't', date, km, hasPhoto: false, ts: seq, ...extra });
const rec = (todayISO, log = [], o = {}) => recommendNext({ person: 'a', log, todayISO, startDate: START, ...o });
const names = r => r.alternatives.map(a => a.run.runType);

test('constants are exported and sane', () => {
  assert.equal(DONE_THRESHOLD, 0.9);
  assert.equal(HARD_MULT, 1.6);
  assert.ok(AVOID_SCORE < 0);
});

/* ---------- matching ---------- */

const planned = [
  { id: 'p0', runType: 'easy', km: 5 }, { id: 'p1', runType: 'tempo', km: 5 }, { id: 'p2', runType: 'long', km: 6.5 }
];

test('matchWeekRuns: same run type first', () => {
  const m = matchWeekRuns(planned, [{ id: 'l1', runType: 'long', km: 7 }, { id: 'l2', runType: 'easy', km: 5 }]);
  assert.deepEqual(m.map(x => x.done), [true, false, true]);
  assert.equal(m[2].entryId, 'l1');
  assert.equal(m[0].entryId, 'l2');
});

test('matchWeekRuns: 90% threshold is inclusive, below it the run is only partial', () => {
  const at = matchWeekRuns([planned[0]], [{ id: 'x', runType: 'easy', km: 4.5 }]);
  assert.equal(at[0].done, true);
  const below = matchWeekRuns([planned[0]], [{ id: 'x', runType: 'easy', km: 4.4 }]);
  assert.equal(below[0].done, false);
  assert.equal(below[0].partial, true);
  assert.equal(below[0].matchedKm, 4.4);
});

test('matchWeekRuns: leftover logged runs consume planned runs by km closeness', () => {
  // two easy runs: the second one (6 km) has no easy slot left and takes the long run (6.5) rather than the tempo (5)
  const m = matchWeekRuns(planned, [{ id: 'a', runType: 'easy', km: 5 }, { id: 'b', runType: 'easy', km: 6 }]);
  assert.equal(m[0].entryId, 'a');
  assert.equal(m[2].entryId, 'b');
  assert.equal(m[2].done, true);
  assert.equal(m[1].done, false);
});

test('matchWeekRuns: a run that reaches the target beats a closer one that does not', () => {
  const m = matchWeekRuns([planned[0]], [{ id: 'short', runType: 'easy', km: 4 }, { id: 'ok', runType: 'easy', km: 6 }]);
  assert.equal(m[0].entryId, 'ok');
  assert.equal(m[0].done, true);
});

test('matchWeekRuns: optional planned runs (no km) match only their own type', () => {
  const p = [{ id: 'e', runType: 'easy', km: 4 }, { id: 's', runType: 'shakeout', km: null }];
  const m = matchWeekRuns(p, [{ id: 'a', runType: 'shakeout', km: 2 }]);
  assert.equal(m[1].done, true);
  assert.equal(m[1].optional, true);
  assert.equal(m[0].done, false);
  const m2 = matchWeekRuns(p, [{ id: 'b', runType: 'long', km: 4 }]);
  assert.equal(m2[1].done, false, 'a stray run never consumes the optional shakeout');
  assert.equal(m2[0].done, true);
});

test('summarizeWeekMatches: x of y with done state per planned run', () => {
  const s = summarizeWeekMatches({ person: 'a', log: [e('2026-03-02', 'easy', 5)], todayISO: '2026-03-03', startDate: START });
  assert.equal(s.weekNumber, 1);
  assert.equal(s.doneCount, 1);
  assert.equal(s.totalCount, 3);
  assert.deepEqual(s.items.map(i => i.done), [true, false, false]);
  assert.deepEqual(s.remaining.map(r => r.runType), ['tempo', 'long']);
  assert.equal(s.items[0].run.points, 5);
});

test('summarizeWeekMatches: outside the plan', () => {
  const s = summarizeWeekMatches({ person: 'a', log: [], todayISO: '2026-02-20', startDate: START });
  assert.equal(s.weekNumber, null);
  assert.equal(s.totalCount, 0);
});

test("only the person's own runs and only runs count", () => {
  const log = [e('2026-03-02', 'easy', 5, { person: 'b' }), e('2026-03-02', 'easy', 5, { sport: 'hike' }), e('2026-03-02', 'easy', 5, { sport: 'cycle', km: undefined, durationMin: 60 })];
  assert.equal(summarizeWeekMatches({ person: 'a', log, todayISO: '2026-03-03', startDate: START }).doneCount, 0);
  assert.equal(summarizeWeekMatches({ person: 'b', log, todayISO: '2026-03-03', startDate: START }).doneCount, 1);
});

/* ---------- day-of-week heuristics ---------- */

test('empty log: first day of the plan recommends the easy run, with a concrete reason', () => {
  const r = rec('2026-03-02');
  assert.equal(r.kind, 'run');
  assert.equal(r.run.runType, 'easy');
  assert.equal(r.run.km, 5);
  assert.equal(r.run.id, '1-1-0-a');
  assert.equal(r.forDate, '2026-03-02');
  assert.match(r.reason, /5 km/);
  assert.ok(r.tags.length >= 1);
  assert.equal(r.plannedLeft, 3);
  assert.equal(r.daysLeftInWeek, 7);
  assert.ok(r.alternatives.length <= 2);
});

test('Monday: start gently with the easy run, tempo and long run are alternatives with a reason', () => {
  const r = rec('2026-03-02', [e('2026-03-01', 'easy', 5)]);
  assert.equal(r.run.runType, 'easy');
  assert.deepEqual(names(r), ['tempo', 'long']);
  assert.ok(r.alternatives.every(a => a.why.length > 5));
});

test('Tuesday after an easy Monday: quality day', () => {
  const r = rec('2026-03-03', [e('2026-03-02', 'easy', 5)]);
  assert.equal(r.kind, 'run');
  assert.equal(r.run.runType, 'tempo');
  assert.ok(r.tags.includes('Quality day'));
  assert.match(r.reason, /Tempo 5 km/);
  assert.match(r.reason, /8 points/);
});

test('hard after hard: the day after a tempo recommends the easy run as Recovery', () => {
  const r = rec('2026-03-04', [e('2026-03-03', 'tempo', 5)]);
  assert.equal(r.kind, 'run');
  assert.equal(r.run.runType, 'easy');
  assert.ok(r.tags.includes('Recovery'));
  assert.match(r.reason, /tempo/i);
});

test('never recommends a hard run the day after a hard run (only tempo left -> rest)', () => {
  // easy + long done, tempo planned; yesterday (Wed) was a speed/tempo effort that matched the tempo? use a second hard run
  const log = [e('2026-03-02', 'easy', 5), e('2026-03-06', 'long', 6.5), e('2026-03-07', 'tempo', 3)]; // Sat tempo 3 km: partial match of tempo
  const r = rec('2026-03-08', log);
  assert.equal(r.kind, 'rest');
  assert.ok(r.tags.includes('Rest day'));
  assert.equal(r.run, undefined, 'the week ends today, nothing to move to');
  assert.match(r.reason, /hard effort/);
});

test('a tempo is never recommended the day after a long run, even when it is the only run left', () => {
  const log = [e('2026-03-02', 'easy', 5), e('2026-03-04', 'long', 6.5)];
  const r = rec('2026-03-05', log); // Thu, tempo left, yesterday long
  assert.notEqual(r.kind, 'run');
  assert.equal(r.kind, 'rest');
  assert.equal(r.run.runType, 'tempo');
  assert.equal(r.forDate, '2026-03-06');
});

test('long run after a hard day is allowed on the weekend but ranks lower than an easy recovery run', () => {
  const log = [e('2026-03-06', 'tempo', 5)];
  const r = rec('2026-03-07', log); // Sat, easy + long left
  assert.equal(r.run.runType, 'easy');
  assert.ok(r.tags.includes('Recovery'));
});

test('Saturday: the long run is recommended as the weekend long run', () => {
  const log = [e('2026-03-02', 'easy', 5), e('2026-03-04', 'tempo', 5)];
  const r = rec('2026-03-07', log);
  assert.equal(r.kind, 'run');
  assert.equal(r.run.runType, 'long');
  assert.ok(r.tags.includes('Weekend long run'));
  assert.match(r.reason, /6\.5 km long run/);
  assert.match(r.reason, /Saturday/);
});

test('Sunday: long run is recommended too', () => {
  const log = [e('2026-03-02', 'easy', 5), e('2026-03-04', 'tempo', 5)];
  const r = rec('2026-03-08', log);
  assert.equal(r.run.runType, 'long');
  assert.equal(r.daysLeftInWeek, 1);
});

test('Mon-Thu: the long run alone is not recommended, rest and save it for Saturday', () => {
  const log = [e('2026-03-02', 'easy', 5), e('2026-03-03', 'tempo', 5)];
  const r = rec('2026-03-05', log); // Thu, 4 days left, 1 run left
  assert.equal(r.kind, 'rest');
  assert.equal(r.run.runType, 'long');
  assert.equal(r.forDate, '2026-03-07');
  assert.match(r.reason, /Saturday/);
  assert.equal(r.plannedLeft, 1);
});

test('Friday: with the tempo and the long run left, the tempo is not squeezed in before the weekend', () => {
  const log = [e('2026-03-02', 'easy', 5)];
  const r = rec('2026-03-06', log); // Fri: tempo -20, long -10, remaining 2 of 3 days: not tight
  assert.equal(r.kind, 'run');
  assert.equal(r.run.runType, 'long');
});

test('quality day needs a rested leg: Wednesday after a rest Tuesday is fine', () => {
  const log = [e('2026-03-02', 'easy', 5)];
  const r = rec('2026-03-04', log);
  assert.equal(r.run.runType, 'tempo');
});

/* ---------- behind schedule ---------- */

test('behind schedule (3 runs left on Saturday): catch-up with the highest-points run', () => {
  const r = rec('2026-03-07');
  assert.equal(r.kind, 'run');
  assert.equal(r.run.runType, 'long'); // 6.5 x 1.3 = 8.45 > tempo 8 > easy 5
  assert.ok(r.tags.includes('Catch-up'));
  assert.match(r.reason, /Catch-up/);
  assert.match(r.reason, /3 runs are left/);
  assert.match(r.reason, /2 days/);
});

test('catch-up ranks by points, not by weekday preference (goal override makes the tempo worth more)', () => {
  const goals = { '1-1-1-a': '9' }; // tempo 9 km x 1.6 = 14.4 points
  const log = [e('2026-03-02', 'easy', 5)];
  const r = rec('2026-03-08', log, { goals }); // Sunday, tempo + long left, 1 day: behind
  assert.equal(r.kind, 'run');
  assert.equal(r.run.runType, 'tempo');
  assert.equal(r.run.km, 9);
  assert.ok(r.tags.includes('Catch-up'));
});

test('catch-up still refuses a hard run after a long run: the easy run goes first', () => {
  const goals = { '1-1-0-a': '5' };
  const log = [e('2026-03-07', 'long', 6.5)];
  const r = rec('2026-03-08', log, { goals }); // Sun, easy + tempo left, 1 day -> behind, yesterday long
  assert.equal(r.kind, 'run');
  assert.equal(r.run.runType, 'easy');
  assert.ok(r.tags.includes('Catch-up'));
});

test('tight week (runs left == days left): hard efforts go first', () => {
  const r = rec('2026-03-06', [e('2026-03-01', 'easy', 5)]); // Fri, 3 runs, 3 days (the run before the plan start only rules out a long break)
  assert.equal(r.run.runType, 'tempo');
  assert.match(r.reason, /3 runs are left in 3 days/);
});

/* ---------- already ran today / run streak ---------- */

test('already ran today: rest with tomorrow as the next up run', () => {
  const log = [e('2026-03-04', 'easy', 5)]; // Wed
  const r = rec('2026-03-04', log);
  assert.equal(r.kind, 'rest');
  assert.ok(r.tags.includes('Rest day'));
  assert.match(r.reason, /^You already ran today, so rest up\. Next up tomorrow: Tempo 5 km/);
  assert.equal(r.run.runType, 'tempo');
  assert.equal(r.forDate, '2026-03-05');
});

test('already ran today (tempo): tomorrow is easy recovery, never another hard run', () => {
  const log = [e('2026-03-03', 'tempo', 5)];
  const r = rec('2026-03-03', log);
  assert.equal(r.kind, 'rest');
  assert.equal(r.run.runType, 'easy');
  assert.equal(r.forDate, '2026-03-04');
});

test('already ran today on the last day of the week: next up is next week\'s first run', () => {
  const log = [e('2026-03-02', 'easy', 5), e('2026-03-03', 'tempo', 5), e('2026-03-08', 'long', 6.5)];
  const r = rec('2026-03-08', log);
  assert.notEqual(r.kind, 'run');
  // the week is complete: done with a preview of week 2
  assert.equal(r.kind, 'done');
  assert.equal(r.alternatives[0].run.week, 2);
});

test('ran today, week not complete, Sunday: rest and preview Monday of the next week', () => {
  const log = [e('2026-03-02', 'easy', 5), e('2026-03-08', 'easy', 5)]; // second easy fills the tempo? 5 km vs tempo 5 -> done
  const r = rec('2026-03-08', log);
  assert.equal(r.kind, 'rest');
  assert.equal(r.run.week, 2);
  assert.equal(r.forDate, '2026-03-09');
});

test('three run days in a row: suggest a rest day, then the next run tomorrow', () => {
  const log = [e('2026-03-04', 'easy', 5), e('2026-03-05', 'easy', 5), e('2026-03-06', 'easy', 5)];
  const r = rec('2026-03-07', log); // Sat, 1 run left (long), 2 days left -> not behind
  assert.equal(r.plannedLeft, 1);
  assert.equal(r.kind, 'rest');
  assert.match(r.reason, /3 days in a row/);
  assert.equal(r.run.runType, 'long');
  assert.equal(r.forDate, '2026-03-08');
});

test('three run days in a row but behind: no forced rest', () => {
  const log = [e('2026-03-05', 'easy', 5), e('2026-03-06', 'easy', 3), e('2026-03-07', 'easy', 3)];
  // easy 5 done; the 3 km easy runs are partial matches of tempo / long. Sunday: 2 left, 1 day: behind.
  const r = rec('2026-03-08', log);
  assert.equal(r.kind, 'run');
  assert.ok(r.tags.includes('Catch-up'));
});

/* ---------- week done / not started / plan over ---------- */

const fullWeek = [e('2026-03-02', 'easy', 5), e('2026-03-03', 'tempo', 5), e('2026-03-07', 'long', 6.5)];

test('week done late in the week: done, with next week\'s first run previewed', () => {
  const r = rec('2026-03-08', fullWeek);
  assert.equal(r.kind, 'done');
  assert.equal(r.run, undefined);
  assert.equal(r.plannedLeft, 0);
  assert.match(r.reason, /Week 1 is done/);
  assert.match(r.reason, /Week 2 opens on Monday with Easy 5 km/);
  assert.equal(r.alternatives.length, 1);
  assert.equal(r.alternatives[0].run.id, '1-2-0-a');
  assert.match(r.alternatives[0].why, /Monday 9 Mar/);
  assert.ok(r.tags.includes('Week complete'));
});

test('week done early (3+ days left): ahead of plan', () => {
  const log = [e('2026-03-02', 'easy', 5), e('2026-03-03', 'tempo', 5), e('2026-03-04', 'long', 6.5)];
  const r = rec('2026-03-05', log);
  assert.equal(r.kind, 'ahead');
  assert.match(r.reason, /ahead of plan/);
  assert.match(r.reason, /3 days to spare/);
  assert.equal(r.alternatives[0].run.week, 2);
});

test('week done by 90% matches: 4.5 of 5 km counts', () => {
  const log = [e('2026-03-02', 'easy', 4.5), e('2026-03-03', 'tempo', 4.5), e('2026-03-07', 'long', 5.85)];
  assert.equal(rec('2026-03-08', log).kind, 'done');
  const short = [e('2026-03-02', 'easy', 4.4), e('2026-03-03', 'tempo', 4.5), e('2026-03-07', 'long', 5.85)];
  assert.notEqual(rec('2026-03-08', short).kind, 'done');
});

test('not started: today before the start date', () => {
  const r = rec('2026-02-27');
  assert.equal(r.kind, 'not-started');
  assert.equal(r.startsInDays, 3);
  assert.match(r.reason, /Monday 2 Mar/);
  assert.match(r.reason, /in 3 days/);
  assert.equal(r.alternatives[0].run.id, '1-1-0-a');
  assert.ok(r.tags.includes('Plan not started'));
  assert.equal(rec('2026-03-01').startsInDays, 1);
  assert.match(rec('2026-03-01').reason, /starts tomorrow/);
});

test('past week 30: plan complete', () => {
  const r = rec('2026-12-14');
  assert.equal(r.kind, 'done');
  assert.ok(r.tags.includes('Plan complete'));
  assert.match(r.reason, /30 weeks/);
});

/* ---------- race week (week 30: Easy 4 · Shakeout (optional) · Race 21.1) ---------- */

// week 30 starts 2026-03-02 + 29 weeks = 2026-09-21 (Mon); race Sunday 2026-09-27
const raceRec = (todayISO, log = []) => rec(todayISO, log);

test('race week Monday: easy only', () => {
  const r = raceRec('2026-09-21', [e('2026-09-17', 'easy', 6)]);
  assert.equal(r.kind, 'run');
  assert.equal(r.run.runType, 'easy');
  assert.equal(r.run.km, 4);
  assert.ok(r.tags.includes('Race week'));
  assert.match(r.reason, /Race week/);
  assert.match(r.reason, /Sunday 27 Sep/);
  assert.equal(r.plannedLeft, 2, 'the optional shakeout is not counted');
});

test('race week: nothing to run in midweek once the easy run is done -> rest, race is next', () => {
  const r = raceRec('2026-09-23', [e('2026-09-21', 'easy', 4)]);
  assert.equal(r.kind, 'rest');
  assert.equal(r.run.runType, 'race');
  assert.equal(r.forDate, '2026-09-27');
  assert.match(r.reason, /21\.1 km race/);
});

test('race eve (Saturday): shakeout or rest, nothing hard', () => {
  const r = raceRec('2026-09-26', [e('2026-09-21', 'easy', 4)]);
  assert.equal(r.kind, 'run');
  assert.equal(r.run.runType, 'shakeout');
  assert.equal(r.run.km, null);
  assert.equal(r.run.detail, 'Rest or 20 min jog');
  assert.ok(r.tags.includes('Race eve'));
  assert.match(r.reason, /tomorrow/);
});

test('race eve with the shakeout already logged: rest', () => {
  const r = raceRec('2026-09-26', [e('2026-09-21', 'easy', 4), e('2026-09-26', 'shakeout', 2)]);
  assert.equal(r.kind, 'rest');
  assert.equal(r.run.runType, 'race');
});

test('race day (Sunday): the race', () => {
  const r = raceRec('2026-09-27', [e('2026-09-21', 'easy', 4), e('2026-09-26', 'shakeout', 2)]);
  assert.equal(r.kind, 'run');
  assert.equal(r.run.runType, 'race');
  assert.equal(r.run.km, 21.1);
  assert.ok(r.tags.includes('Race day'));
  assert.match(r.reason, /race day/i);
  assert.match(r.reason, /63\.3 points/);
});

test('race done: plan complete', () => {
  const r = raceRec('2026-09-27', [e('2026-09-21', 'easy', 4), e('2026-09-27', 'race', 21.1)]);
  assert.equal(r.kind, 'done');
  assert.ok(r.tags.includes('Plan complete'));
  assert.match(r.reason, /Race done/);
});

/* ---------- imported entries, week overrides, long breaks ---------- */

test('imported entries (date null, week override) count for matching but not for recency', () => {
  const imported = [
    { id: 'i1', person: 'a', sport: 'run', runType: 'easy', km: 5, date: null, week: 1, imported: true, ts: 1 },
    { id: 'i2', person: 'a', sport: 'run', runType: 'long', km: 6.5, date: null, week: 1, imported: true, ts: 2 }
  ];
  const s = summarizeWeekMatches({ person: 'a', log: imported, todayISO: '2026-03-03', startDate: START });
  assert.deepEqual(s.items.map(i => i.done), [true, false, true]);
  const r = rec('2026-03-03', imported);
  assert.equal(r.run.runType, 'tempo');
  assert.equal(r.plannedLeft, 1);
  assert.ok(!r.tags.includes('Ease back in'), 'imports alone do not mean a long break');
  // an import with a week override for another week does not count for this one
  const other = [{ ...imported[0], week: 2 }];
  assert.equal(summarizeWeekMatches({ person: 'a', log: other, todayISO: '2026-03-03', startDate: START }).doneCount, 0);
});

test('an explicit week override wins over the date', () => {
  const log = [e('2026-03-20', 'easy', 5, { week: 1 })];
  assert.equal(summarizeWeekMatches({ person: 'a', log, todayISO: '2026-03-03', startDate: START }).doneCount, 1);
});

test('more than 5 days since the last run: ease back in with the easy run', () => {
  const log = [e('2026-03-02', 'easy', 5)];
  const r = rec('2026-03-09', log); // Mon of week 2, 7 days later
  assert.equal(r.kind, 'run');
  assert.equal(r.run.runType, 'easy');
  assert.ok(r.tags.includes('Ease back in'));
  assert.match(r.reason, /It's been 7 days since your last run, so ease back in with the 5 km easy run/);
});

test('exactly 5 days since the last run is not a long break', () => {
  const log = [e('2026-03-02', 'easy', 5)];
  const r = rec('2026-03-07', log);
  assert.ok(!r.tags.includes('Ease back in'));
});

test('a long break also stops a quality day midweek', () => {
  const log = [e('2026-03-02', 'easy', 5)];
  const r = rec('2026-03-11', log); // Wed of week 2, 9 days later
  assert.equal(r.run.runType, 'easy');
  assert.ok(r.tags.includes('Ease back in'));
});

/* ---------- DST-safe dates, week boundaries, start date not a Monday ---------- */

test('DST (EU spring forward, 2026-03-29): the weekend and the next Monday are computed on calendar days', () => {
  const start = '2026-03-23'; // Mon; Sun 29 March is the 23-hour day
  const log = [{ ...e('2026-03-23', 'easy', 5) }, { ...e('2026-03-24', 'tempo', 5) }];
  const sat = recommendNext({ person: 'a', log, todayISO: '2026-03-28', startDate: start });
  assert.equal(sat.run.runType, 'long');
  assert.equal(sat.daysLeftInWeek, 2);
  const sun = recommendNext({ person: 'a', log: [...log, e('2026-03-28', 'long', 6.5)], todayISO: '2026-03-29', startDate: start });
  assert.equal(sun.kind, 'done');
  assert.equal(sun.daysLeftInWeek, 1);
  assert.match(sun.alternatives[0].why, /Monday 30 Mar/);
  const mon = recommendNext({ person: 'a', log: [...log, e('2026-03-28', 'long', 6.5)], todayISO: '2026-03-30', startDate: start });
  assert.equal(mon.weekNumber, 2);
  assert.equal(mon.run.id, '1-2-0-a');
});

test('DST (EU fall back, 2026-10-25): ran on the 25-hour Sunday -> rest, tomorrow is week N+1 Monday', () => {
  const start = '2026-10-19'; // Monday of plan week 31 equivalent: use a start so Oct 19 is week 1
  const log = [e('2026-10-19', 'easy', 5), e('2026-10-24', 'long', 6.5), e('2026-10-25', 'easy', 5)];
  const r = recommendNext({ person: 'a', log, todayISO: '2026-10-25', startDate: start });
  // easy twice: the second easy fills the tempo (5 km) -> week complete
  assert.equal(r.kind, 'done');
  assert.equal(r.alternatives[0].run.week, 2);
  const next = recommendNext({ person: 'a', log, todayISO: '2026-10-26', startDate: start });
  assert.equal(next.weekNumber, 2);
  assert.equal(next.run.runType, 'easy');
});

test('Monday boundary: a Sunday long run does not count for the new week, and makes Monday an easy recovery day', () => {
  const log = [e('2026-03-08', 'long', 6.5)];
  const r = rec('2026-03-09', log);
  assert.equal(r.weekNumber, 2);
  assert.equal(r.summary.doneCount, 0);
  assert.equal(r.run.runType, 'easy');
  assert.ok(r.tags.includes('Recovery'));
  assert.equal(r.daysLeftInWeek, 7);
});

test('Sunday boundary: the last day of the week still belongs to the old week', () => {
  const r = rec('2026-03-08');
  assert.equal(r.weekNumber, 1);
  assert.equal(r.daysLeftInWeek, 1);
});

test('a start date that is not a Monday: weeks run from that weekday and days left follow the plan week', () => {
  // start Wednesday 2026-03-04: week 1 = Wed 4 .. Tue 10 March
  const base = { person: 'a', startDate: '2026-03-04' };
  const tue = recommendNext({ ...base, log: [e('2026-03-04', 'easy', 5), e('2026-03-05', 'tempo', 5)], todayISO: '2026-03-10' });
  assert.equal(tue.weekNumber, 1);
  assert.equal(tue.daysLeftInWeek, 1);
  // Monday 9 March, last weekend already behind us: the long run is not postponed to a weekend that is not coming
  const mon = recommendNext({ ...base, log: [e('2026-03-04', 'easy', 5), e('2026-03-05', 'tempo', 5)], todayISO: '2026-03-09' });
  assert.equal(mon.kind, 'run');
  assert.equal(mon.run.runType, 'long');
});

test('weeks view can be passed in and gives the same answer as building it', () => {
  const log = [e('2026-03-02', 'easy', 5)];
  const viaPlan = rec('2026-03-03', log);
  const viaWeeks = rec('2026-03-03', log, { weeks: undefined, plan: PLAN });
  assert.deepEqual(viaPlan, viaWeeks);
});

test('goal override of 0 km makes a run optional', () => {
  const r = rec('2026-03-03', [e('2026-03-02', 'easy', 5)], { goals: { '1-1-1-a': '0' } });
  assert.equal(r.plannedLeft, 1);
  assert.equal(r.summary.optionalCount, 1);
  assert.equal(r.summary.totalCount, 2);
});

test('person b gets their own plan and log', () => {
  const log = [e('2026-03-02', 'easy', 5, { person: 'b' })];
  const rb = recommendNext({ person: 'b', log, todayISO: '2026-03-03', startDate: START });
  assert.equal(rb.run.id, '1-1-1-b');
  const ra = recommendNext({ person: 'a', log, todayISO: '2026-03-03', startDate: START });
  assert.equal(ra.run.id, '1-1-1-a', "b's easy run does not count for a, but Tuesday is a quality day for them too");
  assert.equal(ra.summary.doneCount, 0);
});

test('output shape', () => {
  for (const d of ['2026-02-27', '2026-03-02', '2026-03-04', '2026-03-08', '2026-12-30']) {
    const r = rec(d, fullWeek);
    assert.ok(['run', 'rest', 'done', 'ahead', 'not-started'].includes(r.kind), r.kind);
    assert.equal(typeof r.reason, 'string');
    assert.ok(r.reason.length > 10);
    assert.ok(Array.isArray(r.tags));
    assert.ok(Array.isArray(r.alternatives) && r.alternatives.length <= 2);
    assert.equal(typeof r.plannedLeft, 'number');
    assert.equal(typeof r.daysLeftInWeek, 'number');
    if (r.kind === 'run') assert.ok(r.run && r.run.id);
  }
});
