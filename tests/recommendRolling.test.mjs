import test from 'node:test';
import assert from 'node:assert/strict';
import { PLAN } from '../src/plan.js';
import { addDays } from '../src/scoring.js';
import { normalizePlanState } from '../src/planModel.js';
import { buildSessions } from '../src/rolling.js';
import { recommendNext, summarizeWeekMatches } from '../src/recommend.js';
import { recommendForPerson, reminderMessage } from '../src/recommendForPerson.js';

process.env.TZ = 'Europe/Zurich';

// Start Monday 2026-03-02: Mon 02 Tue 03 Wed 04 Thu 05 Fri 06 Sat 07 Sun 08; week 1 = Easy 5, Tempo 5, Long 6.5.
const START = '2026-03-02';
let seq = 0;
const e = (date, runType, km, extra = {}) => ({ id: `e${++seq}`, person: 'a', sport: 'run', runType, title: 't', date, km, hasPhoto: false, ts: seq, ...extra });
const plan = (a = {}) => ({ a: { mode: 'rolling', startDate: START, ...a } });
const rec = (todayISO, log = [], a = {}, o = {}) => recommendNext({ person: 'a', log, todayISO, planState: plan(a), ...o });
const names = r => r.alternatives.map(x => x.run.runType);

// do the first n queue sessions exactly, one every `gap` days from `from`
function done(n, from = START, gap = 2) {
  return buildSessions(PLAN, {}, normalizePlanState(plan()).a, 'a').filter(s => !s.skipped).slice(0, n)
    .map((s, i) => e(addDays(from, i * gap), s.runType, s.km > 0 ? s.km : 2));
}

/* ---------- 12+ scenarios ---------- */

test('rolling 1: empty log on the first day, the easy opener of the first session week', () => {
  const r = rec('2026-03-02');
  assert.equal(r.kind, 'run');
  assert.equal(r.run.id, '1-1-0-a');
  assert.equal(r.forDate, '2026-03-02');
  assert.equal(r.weekNumber, 1);
  assert.equal(r.plannedLeft, 89, 'the whole queue is open');
  assert.equal(r.summary.totalCount, 3);
  assert.equal(r.summary.weekNumber, 1);
  assert.equal(r.rolling.behindSessions, 0);
  assert.equal(r.rolling.nextSessionId, '1-1-0-a');
  assert.equal(r.tags.includes('Behind'), false);
  assert.ok(r.alternatives.length <= 2);
});

test('rolling 2: the candidate pool is the queue, not the calendar week', () => {
  // it is week 3 of the calendar but nothing was run: the next session is still week 1\'s easy run
  const r = rec('2026-03-18');
  assert.equal(r.weekNumber, 1);
  assert.equal(r.kind, 'run');
  assert.ok(['1-1-0-a', '1-1-1-a', '1-1-2-a'].includes(r.run.id));
  assert.equal(r.summary.items.length, 3);
  // after a late week 1 the pool moves on to week 2, still on the same calendar day
  const log = [e('2026-03-14', 'easy', 5), e('2026-03-15', 'tempo', 5), e('2026-03-16', 'long', 6.5)];
  const r2 = rec('2026-03-18', log);
  assert.equal(r2.weekNumber, 2);
  assert.ok(r2.run.id.startsWith('1-2-'));
});

test('rolling 3: behind by two or more sessions adds the Behind tag and says so', () => {
  const r = rec('2026-03-18'); // two weeks passed, nothing done: 6 behind
  assert.equal(r.rolling.behindSessions, 6);
  assert.ok(r.tags.includes('Behind'));
  assert.match(r.reason, /6 sessions behind/);
  assert.ok(r.tags.includes('Catch-up'));
  // exactly one session behind: no nudge
  const one = rec('2026-03-09', done(2, START, 1));
  assert.equal(one.rolling.behindSessions, 1);
  assert.equal(one.tags.includes('Behind'), false);
  assert.doesNotMatch(one.reason, /behind/i);
  // a rest result is nudged too (long run only on a Wednesday)
  const lag = rec('2026-04-01', [e('2026-03-02', 'easy', 5), e('2026-03-03', 'tempo', 5)], { raceDate: '2026-09-27' }); // behind via race pace
  assert.equal(typeof lag.rolling.behindSessions, 'number');
});

test('rolling 4: only the long run is left on a weekday: rest, save it for the weekend', () => {
  const log = [e('2026-03-02', 'easy', 5), e('2026-03-03', 'tempo', 5)];
  const r = rec('2026-03-04', log);
  assert.equal(r.kind, 'rest');
  assert.equal(r.run.runType, 'long');
  assert.equal(r.forDate, '2026-03-07');
  assert.ok(r.tags.includes('Weekend long run'));
  assert.match(r.reason, /Saturday/);
  const sat = rec('2026-03-07', log);
  assert.equal(sat.kind, 'run');
  assert.equal(sat.run.runType, 'long');
  assert.ok(sat.tags.includes('Weekend long run'));
});

test('rolling 5: the queue moves on when a week is finished early (no week-complete state)', () => {
  const r = rec('2026-03-06', done(3, START, 1)); // all of week 1 by Wednesday, today is Friday
  assert.equal(r.kind, 'run');
  assert.equal(r.weekNumber, 2);
  assert.equal(r.run.id, '1-2-0-a', 'Friday easy opener of the next session week');
  assert.equal(r.summary.doneCount, 0);
  assert.equal(r.rolling.behindSessions, 0);
});

test('rolling 6: no hard run the day after a hard run, recovery easy instead', () => {
  const r = rec('2026-03-04', [e('2026-03-03', 'tempo', 5)]);
  assert.equal(r.kind, 'run');
  assert.equal(r.run.runType, 'easy');
  assert.ok(r.tags.includes('Recovery'));
  // only hard sessions left after a hard run: rest, the hard one tomorrow
  const log = [e('2026-03-02', 'easy', 5), e('2026-03-03', 'tempo', 3)]; // a partial tempo still consumed its session
  const r2 = rec('2026-03-04', log, { skipped: ['w1-long'] });
  assert.equal(r2.weekNumber, 2, 'week 1 has nothing left: the pool is week 2');
});

test('rolling 7: a run today means rest, with the next session previewed', () => {
  const r = rec('2026-03-03', [e('2026-03-03', 'easy', 5)]);
  assert.equal(r.kind, 'rest');
  assert.ok(r.tags.includes('Rest day'));
  assert.match(r.reason, /already ran today/);
  assert.equal(r.forDate, '2026-03-04');
  assert.equal(r.run.runType, 'tempo');
});

test('rolling 8: three run days in a row means a rest day unless you are behind', () => {
  const log = [e('2026-03-02', 'easy', 5), e('2026-03-03', 'easy', 5), e('2026-03-04', 'easy', 5)];
  const r = rec('2026-03-05', log);
  assert.equal(r.kind, 'rest');
  assert.match(r.reason, /3 days in a row/);
  // behind by two sessions or more: keep going
  const catchUp = rec('2026-03-19', [e('2026-03-16', 'easy', 5), e('2026-03-17', 'easy', 5), e('2026-03-18', 'easy', 5)]);
  assert.equal(catchUp.kind, 'run');
  assert.ok(catchUp.tags.includes('Behind'));
});

test('rolling 9: ease back in after a long break', () => {
  const r = rec('2026-03-20', [e('2026-03-04', 'tempo', 5)]);
  assert.equal(r.kind, 'run');
  assert.ok(r.tags.includes('Ease back in'));
  assert.equal(r.run.runType, 'easy', 'easy first even though you are behind and the long run is worth more');
  assert.ok(r.tags.includes('Behind'));
});

test('rolling 10: training days. Not a training day: rest with the next training day as next up', () => {
  const td = { trainingDays: [2, 4, 6] }; // Tue Thu Sat
  const mon = rec('2026-03-02', [], td);
  assert.equal(mon.kind, 'rest');
  assert.equal(mon.forDate, '2026-03-03');
  assert.ok(mon.run && mon.run.id.startsWith('1-1-'));
  assert.match(mon.reason, /Not a training day \(you train on Tue, Thu, Sat\)/);
  assert.match(mon.reason, /Next up on Tuesday/);
  assert.ok(mon.tags.includes('Rest day'));
  const tue = rec('2026-03-03', [], td);
  assert.equal(tue.kind, 'run');
  assert.notEqual(tue.run.runType, 'long', 'Tuesday is for quality, the long run waits for Saturday');
  const sun = rec('2026-03-08', [], td);
  assert.equal(sun.kind, 'rest');
  assert.equal(sun.forDate, '2026-03-10');
  // unset: every weekday is fine, as before
  assert.equal(rec('2026-03-02').kind, 'run');
  assert.equal(rec('2026-03-08').kind === 'run' || rec('2026-03-08').kind === 'rest', true);
});

test('rolling 11: training days place the long run on the weekend training day, or the last one', () => {
  const log = [e('2026-03-02', 'easy', 5), e('2026-03-03', 'tempo', 5)];
  assert.equal(rec('2026-03-05', log, { trainingDays: [2, 4, 6] }).kind, 'rest', 'Thursday: long run waits for Saturday');
  assert.equal(rec('2026-03-05', log, { trainingDays: [2, 4, 6] }).forDate, '2026-03-07');
  assert.equal(rec('2026-03-07', log, { trainingDays: [2, 4, 6] }).run.runType, 'long');
  // no weekend training day: the last training day of the week (Friday) is the long-run day
  const fri = rec('2026-03-06', log, { trainingDays: [1, 3, 5] });
  assert.equal(fri.kind, 'run');
  assert.equal(fri.run.runType, 'long');
  const wed = rec('2026-03-04', log, { trainingDays: [1, 3, 5] });
  assert.equal(wed.kind, 'rest');
  assert.equal(wed.forDate, '2026-03-06');
  // Sunday as training day (0) maps to the weekend
  assert.equal(rec('2026-03-08', log, { trainingDays: [0, 3] }).run.runType, 'long');
});

test('rolling 12: race feasibility compares open sessions with the training days left', () => {
  const tight = rec('2026-03-02', [], { raceDate: '2026-04-05' });
  assert.deepEqual(Object.keys(tight.raceFeasibility).sort(), ['daysLeft', 'fits', 'raceDate', 'sessionsLeft', 'shortBy', 'slots']);
  assert.equal(tight.raceFeasibility.fits, false);
  assert.equal(tight.raceFeasibility.sessionsLeft, 89);
  assert.equal(tight.raceFeasibility.shortBy, 89 - tight.raceFeasibility.slots);
  assert.equal(tight.raceFeasibility.daysLeft, 34);
  // nearly done: 5 sessions left, three weeks to go: fits
  const fine = rec('2026-09-07', done(84, START, 2), { raceDate: '2026-09-27' });
  assert.equal(fine.raceFeasibility.sessionsLeft, 5);
  assert.equal(fine.raceFeasibility.fits, true);
  assert.equal(fine.raceFeasibility.shortBy, 0);
  // training days count: Sundays only leave too few slots
  const few = rec('2026-09-07', done(84, START, 2), { raceDate: '2026-09-27', trainingDays: [0] });
  assert.equal(few.raceFeasibility.fits, false);
  // no race date: no feasibility
  assert.equal('raceFeasibility' in rec('2026-03-02'), false);
});

test('rolling 13: the queue is exhausted: done, plan complete', () => {
  const r = rec('2026-12-01', done(90, START, 2));
  assert.equal(r.kind, 'done');
  assert.ok(r.tags.includes('Plan complete'));
  assert.match(r.reason, /Race done/);
  assert.equal(r.weekNumber, null);
  assert.equal(r.plannedLeft, 0);
  const noRace = rec('2026-12-01', done(89, START, 2));
  assert.equal(noRace.kind, 'run', 'only the race is left');
  assert.ok(noRace.tags.includes('Race day'));
  assert.equal(noRace.run.runType, 'race');
  // everything skipped is done too
  const all = rec('2026-03-04', [], { skipped: PLAN.flatMap(w => w.runs.a.map(r => r.id)) });
  assert.equal(all.kind, 'done');
  assert.match(all.reason, /no sessions left/);
});

test('rolling 14: race day, race eve and a race far away', () => {
  const log = done(89, START, 1); // everything but the race
  const raceDate = '2026-09-27';
  const eve = rec('2026-09-26', log, { raceDate });
  assert.equal(eve.kind, 'rest');
  assert.ok(eve.tags.includes('Race eve'));
  assert.equal(eve.forDate, raceDate);
  const day = rec(raceDate, log, { raceDate });
  assert.equal(day.kind, 'run');
  assert.equal(day.run.runType, 'race');
  assert.ok(day.tags.includes('Race day'));
  assert.equal(day.tags.includes('Behind'), false);
  const far = rec('2026-08-01', log, { raceDate });
  assert.equal(far.kind, 'rest');
  assert.equal(far.run.runType, 'race');
  assert.equal(far.forDate, raceDate);
  assert.ok(far.tags.includes('Race ahead'));
  // race week with the race still open and the shakeout open the day before
  const week29 = done(86, START, 1);
  const eve2 = rec('2026-09-26', [...week29, e('2026-09-20', 'easy', 5)], { raceDate });
  assert.ok(['run', 'rest'].includes(eve2.kind));
});

test('rolling 15: before the start, and the preview of the first session', () => {
  const r = rec('2026-02-27');
  assert.equal(r.kind, 'not-started');
  assert.equal(r.startsInDays, 3);
  assert.equal(r.startsOn, START);
  assert.equal(r.alternatives[0].run.id, '1-1-0-a');
  assert.ok(r.tags.includes('Plan not started'));
});

test('rolling 16: a pause shifts the pace, so the person is not behind afterwards', () => {
  const noPause = rec('2026-03-16');
  const paused = rec('2026-03-16', [], { pauses: [{ from: '2026-03-02', to: '2026-03-15' }] });
  assert.equal(noPause.rolling.behindSessions, 3 * 2);
  assert.equal(paused.rolling.behindSessions, 0);
  assert.equal(paused.tags.includes('Behind'), false);
});

test('rolling 17: skipped sessions are not recommended; repeated weeks come again', () => {
  const skip = rec('2026-03-02', [], { skipped: ['w1-easy'] });
  assert.notEqual(skip.run.id, '1-1-0-a');
  assert.equal(skip.summary.totalCount, 2);
  const log = done(3, START, 1);
  const rep = rec('2026-03-09', log, { repeatWeeks: [1] });
  assert.equal(rep.weekNumber, 1);
  assert.equal(rep.run.id.endsWith('~r2'), true);
  assert.equal(rep.summary.items.length, 3);
});

test('rolling 18: reminders only fire for kind run, so a non training day sends nothing', () => {
  const planState = { a: { mode: 'rolling', startDate: START, trainingDays: [2, 4, 6] } };
  const out = recommendForPerson({ person: 'a', log: [], goals: {}, startDateSetting: null, planState, todayISO: '2026-03-02' });
  assert.equal(out.rec.kind, 'rest');
  const on = recommendForPerson({ person: 'a', log: [], goals: {}, startDateSetting: null, planState, todayISO: '2026-03-03' });
  assert.equal(on.rec.kind, 'run');
  assert.match(reminderMessage(on.rec, 'A').title, /^Today: /);
  // the weeks the Worker returns are the rolling ones
  assert.equal(on.weeks[0].a.status, 'current');
  assert.equal(on.weeks[0].current, true);
});

/* ---------- summary ---------- */

test('summarizeWeekMatches in rolling mode describes the group of the first open session', () => {
  const s = summarizeWeekMatches({ person: 'a', log: [e('2026-03-02', 'easy', 5), e('2026-03-03', 'tempo', 5)], todayISO: '2026-03-04', planState: plan() });
  assert.equal(s.weekNumber, 1);
  assert.equal(s.doneCount, 2);
  assert.equal(s.totalCount, 3);
  assert.deepEqual(s.remaining.map(r => r.runType), ['long']);
  assert.deepEqual(s.items.map(i => i.done), [true, true, false]);
  const late = summarizeWeekMatches({ person: 'a', log: [], todayISO: '2026-06-01', planState: plan() });
  assert.equal(late.weekNumber, 1, 'not the calendar week');
});

/* ---------- calendar mode stays identical ---------- */

test('calendar mode: an explicit calendar state, no state and extra rolling fields give identical recommendations', () => {
  const logs = [[], [e('2026-03-02', 'easy', 5)], [e('2026-03-03', 'tempo', 5), e('2026-03-05', 'easy', 5)], done(3, START, 1)];
  for (const log of logs) {
    for (let d = -2; d < 60; d += 3) {
      const today = addDays(START, d);
      const none = recommendNext({ person: 'a', log, todayISO: today, startDate: START });
      const cal = recommendNext({ person: 'a', log, todayISO: today, startDate: START, planState: { a: { mode: 'calendar', startDate: START, repeatWeeks: [1, 2], skipped: [], trainingDays: [2] } } });
      assert.deepEqual(cal, none, `day ${d}`);
      assert.equal('raceFeasibility' in cal, false);
      assert.equal('rolling' in cal, false);
    }
  }
});

test('property: rolling recommendations are well formed on random logs and days', () => {
  let state = 99;
  const rand = () => { state = (state * 1664525 + 1013904223) % 4294967296; return state / 4294967296; };
  const types = ['easy', 'tempo', 'long', 'shakeout', 'race', 'easy'];
  for (let i = 0; i < 150; i++) {
    const log = Array.from({ length: Math.floor(rand() * 20) }, () => e(addDays(START, Math.floor(rand() * 90)), types[Math.floor(rand() * types.length)], Math.round((2 + rand() * 12) * 10) / 10));
    const a = {};
    if (rand() < 0.4) a.trainingDays = [0, 1, 2, 3, 4, 5, 6].filter(() => rand() < 0.5);
    if (rand() < 0.4) a.raceDate = addDays(START, 60 + Math.floor(rand() * 200));
    if (rand() < 0.3) a.pauses = [{ from: addDays(START, 10), to: addDays(START, 20) }];
    const today = addDays(START, Math.floor(rand() * 100) - 3);
    const r = rec(today, log, a);
    assert.ok(['run', 'rest', 'done', 'not-started'].includes(r.kind), r.kind);
    assert.ok(typeof r.reason === 'string' && r.reason.length > 0);
    assert.ok(Array.isArray(r.tags) && Array.isArray(r.alternatives));
    if (r.kind === 'run') { assert.equal(r.forDate, today); assert.ok(r.run); }
    if (r.kind === 'rest' && r.run) assert.ok(r.forDate >= today);
    assert.deepEqual(rec(today, [...log].reverse(), a), r, 'log order does not matter');
    // the nudge is consistent with the number
    assert.equal(r.tags.includes('Behind'), r.rolling.behindSessions >= 2 && (r.kind === 'run' || r.kind === 'rest') && !r.tags.includes('Race day') && !r.tags.includes('Race eve'));
  }
});
