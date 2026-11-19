import test from 'node:test';
import assert from 'node:assert/strict';
import {
  WEEKDAY_CHIPS, toggleTrainingDay, trainingDaysText, stepTarget, raceCountdown, raceCountdownText, raceHeadline,
  raceDateError, idealStartForRace, raceAlignment, pauseError, quickPause, pauseRangeText, pauseState, activePause,
  withPause, withoutPause, sessionLabel, sessionsLeft, planHeaderText
} from '../src/utils/planSettingsForm.js';
import { normalizeTrainingDays } from '../src/planModel.js';
import { mondayOf } from '../src/scoring.js';

test('weekday chips are Monday first and map to stored values 0 = Sunday', () => {
  assert.deepEqual(WEEKDAY_CHIPS.map(c => c.day), [1, 2, 3, 4, 5, 6, 0]);
  assert.deepEqual(WEEKDAY_CHIPS.map(c => c.short), ['Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat', 'Sun']);
  // every chip value survives the planModel normalisation
  assert.deepEqual(normalizeTrainingDays(WEEKDAY_CHIPS.map(c => c.day)), [0, 1, 2, 3, 4, 5, 6]);
});

test('toggleTrainingDay adds, removes, dedupes and sorts', () => {
  assert.deepEqual(toggleTrainingDay([], 4), [4]);
  assert.deepEqual(toggleTrainingDay([4], 0), [0, 4]);
  assert.deepEqual(toggleTrainingDay([0, 2, 4], 2), [0, 4]);
  assert.deepEqual(toggleTrainingDay([4], 4), []);
  assert.deepEqual(toggleTrainingDay(undefined, 6), [6]);
  assert.deepEqual(toggleTrainingDay([1, 1, 9], 3), [1, 3]);
  assert.equal(trainingDaysText([0, 2, 4, 6]), 'Tue, Thu, Sat, Sun');
  assert.equal(trainingDaysText([]), '');
});

test('stepTarget stays within 1..14 and starts from the fallback when automatic', () => {
  assert.equal(stepTarget(null, 1, 3), 4);
  assert.equal(stepTarget(null, -1, 3), 2);
  assert.equal(stepTarget(1, -1), 1);
  assert.equal(stepTarget(14, 1), 14);
  assert.equal(stepTarget(3, 1), 4);
});

test('race countdown: weeks, extra days, today and past', () => {
  assert.deepEqual(raceCountdown('2026-03-02', '2026-03-02'), { days: 0, weeks: 0, extraDays: 0, today: true, past: false });
  assert.deepEqual(raceCountdown('2026-03-02', '2026-03-09'), { days: 7, weeks: 1, extraDays: 0, today: false, past: false });
  assert.deepEqual(raceCountdown('2026-03-02', '2026-05-28'), { days: 87, weeks: 12, extraDays: 3, today: false, past: false });
  assert.equal(raceCountdown('2026-03-02', '2026-02-27').past, true);
  assert.equal(raceCountdown('nope', '2026-02-27'), null);
  assert.equal(raceCountdownText('2026-03-02', '2026-05-28'), '12 weeks and 3 days left');
  assert.equal(raceCountdownText('2026-03-02', '2026-03-09'), '1 week left');
  assert.equal(raceCountdownText('2026-03-02', '2026-03-03'), '1 day left');
  assert.equal(raceCountdownText('2026-03-02', '2026-03-02'), 'Race day is today');
  assert.equal(raceCountdownText('2026-03-02', '2026-02-27'), 'Race day was 3 days ago');
  assert.equal(raceHeadline('2026-03-02', '2026-05-28'), '12 weeks to race day');
  assert.equal(raceHeadline('2026-03-02', '2026-03-05'), '3 days to race day');
  assert.equal(raceHeadline('2026-03-02', '2026-02-01'), '');
});

test('race week math is DST safe (spring and autumn changes do not move a day)', () => {
  // Europe: clocks change on 29 Mar and 25 Oct 2026; counting must stay whole days
  assert.equal(raceCountdown('2026-03-23', '2026-04-06').days, 14);
  assert.equal(raceCountdown('2026-10-19', '2026-11-02').days, 14);
  assert.equal(raceCountdown('2026-03-01', '2026-11-01').days, 245);
  // 30 weeks from a Monday in March cross the spring change: the 30th week still ends on a Sunday
  const a = raceAlignment('2026-03-02', '2026-09-27');
  assert.equal(a.diff, 0);
  assert.equal(new Date(Date.UTC(2026, 8, 27)).getUTCDay(), 0);
});

test('race date must be after the start date', () => {
  assert.equal(raceDateError('', '2026-03-02'), '');
  assert.equal(raceDateError('2026-03-02', '2026-03-02'), 'The race date has to be after your start date.');
  assert.equal(raceDateError('2026-02-01', '2026-03-02'), 'The race date has to be after your start date.');
  assert.equal(raceDateError('2026-09-27', '2026-03-02'), '');
  assert.equal(raceDateError('2026-09-27', null), '');
  assert.match(raceDateError('2026-02-30', null), /valid/);
});

test('ideal start puts the race into week 30 and is always a Monday', () => {
  assert.equal(idealStartForRace('2026-09-27'), '2026-03-02'); // Sunday of week 30 -> Monday 29 weeks earlier
  for (const race of ['2026-09-20', '2026-09-26', '2026-10-31', '2027-03-28']) {
    const start = idealStartForRace(race);
    assert.equal(start, mondayOf(start));
    const a = raceAlignment(start, race);
    assert.equal(a.diff, 0, race);
  }
  assert.equal(idealStartForRace('bad'), null);
});

test('raceAlignment: slack, shortfall and missing input', () => {
  assert.equal(raceAlignment(null, '2026-09-27'), null);
  assert.equal(raceAlignment('2026-03-02', '2026-03-01'), null);
  const slack = raceAlignment('2026-03-02', '2026-10-25'); // 34 weeks
  assert.equal(slack.diff, 4);
  assert.match(slack.hint, /4 weeks more/);
  const tight = raceAlignment('2026-03-02', '2026-08-30'); // 26 weeks
  assert.equal(tight.diff, -4);
  assert.match(tight.hint, /4 weeks longer/);
  assert.equal(raceAlignment('2026-03-02', '2026-03-09').diff, 2 - 30);
  assert.match(raceAlignment('2026-03-02', '2026-09-27').hint, /end right at race day/);
});

test('pause validation, quick pause and labels', () => {
  assert.equal(pauseError({}), 'Pick both dates.');
  assert.equal(pauseError({ from: '2026-04-02', to: '2026-04-01' }), 'The end date has to be on or after the start date.');
  assert.equal(pauseError({ from: '2026-04-01', to: '2026-04-01' }), '');
  assert.equal(pauseError({ from: '2026-02-30', to: '2026-04-01' }), 'Enter valid dates.');
  assert.deepEqual(quickPause('2026-04-01', '2026-04-10'), { ok: true, pause: { from: '2026-04-01', to: '2026-04-10' } });
  assert.deepEqual(quickPause('2026-04-01', '2026-04-10', '  flu '), { ok: true, pause: { from: '2026-04-01', to: '2026-04-10', note: 'flu' } });
  assert.deepEqual(quickPause('2026-04-01', '2026-03-30'), { ok: false, error: 'Pick a date from today on.' });
  assert.equal(quickPause('2026-04-01', '').ok, false);
  assert.equal(pauseRangeText({ from: '2026-04-12', to: '2026-04-20' }, '2026-04-01'), '12 Apr to 20 Apr · 9 days');
  assert.equal(pauseRangeText({ from: '2026-04-12', to: '2026-04-12' }, '2026-04-01'), '12 Apr · 1 day');
  assert.equal(pauseRangeText({ from: '2025-12-28', to: '2026-01-03' }, '2026-04-01'), '28 Dec 2025 to 3 Jan · 7 days');
  assert.equal(pauseState({ from: '2026-04-01', to: '2026-04-03' }, '2026-04-02'), 'active');
  assert.equal(pauseState({ from: '2026-04-01', to: '2026-04-03' }, '2026-03-31'), 'upcoming');
  assert.equal(pauseState({ from: '2026-04-01', to: '2026-04-03' }, '2026-04-04'), 'past');
  const ps = [{ from: '2026-04-01', to: '2026-04-03' }, { from: '2026-05-01', to: '2026-05-02' }];
  assert.equal(activePause(ps, '2026-05-02'), ps[1]);
  assert.equal(activePause(ps, '2026-04-10'), null);
  assert.deepEqual(withoutPause(ps, 0), [ps[1]]);
  assert.deepEqual(withPause(ps, { from: '2026-06-01', to: '2026-06-02' }).length, 3);
  assert.equal(ps.length, 2); // inputs are not mutated
});

test('sessionLabel names session ids and legacy run ids', () => {
  assert.equal(sessionLabel('w7-speed'), 'Week 7 · Speed');
  assert.equal(sessionLabel('w12-long'), 'Week 12 · Long run');
  assert.equal(sessionLabel('1-7-1-a'), 'Week 7 · Tempo');
  assert.equal(sessionLabel('1-7-1-a~r2'), 'Week 7 · Tempo (repeat)');
  assert.equal(sessionLabel('w7-speed~r2'), 'Week 7 · Speed (repeat)');
  assert.equal(sessionLabel('mystery'), 'mystery');
  assert.equal(sessionLabel(null), '');
});

test('sessionsLeft counts unfinished planned runs and subtracts logged ones', () => {
  const run = km => ({ km });
  const entry = { sport: 'run', km: 5 };
  const weeks = [
    { a: { status: 'fulfilled', runs: [run(5), run(5), run(5)], entries: [] } },
    { a: { status: 'current', runs: [run(5), run(5), run(6)], entries: [entry] } },
    { a: { status: 'upcoming', runs: [run(5), run(5), run(null)], entries: [] } },
    { a: { status: 'n/a', runs: [], entries: [] } },
    { a: { status: 'missed', runs: [run(5)], entries: [entry, entry] } }
  ];
  assert.equal(sessionsLeft(weeks, 'a'), 2 + 2 + 0);
  // flexible weeks use the engine's counts
  const rolling = [{ a: { status: 'fulfilled', sessionsTotal: 3, sessionsDone: 3, runs: [] } }, { a: { status: 'current', sessionsTotal: 3, sessionsDone: 1, runs: [] } }, { a: { status: 'upcoming', sessionsTotal: 2, sessionsDone: 0, runs: [] } }];
  assert.equal(sessionsLeft(rolling, 'a'), 4);
  assert.equal(sessionsLeft([], 'a'), 0);
  assert.equal(sessionsLeft(undefined, 'a'), 0);
});

test('planHeaderText joins what is known', () => {
  assert.equal(planHeaderText({ todayISO: '2026-03-02', raceISO: '2026-05-28', sessions: 31 }), '12 weeks to race day · 31 sessions left');
  assert.equal(planHeaderText({ todayISO: '2026-03-02', sessions: 1 }), '1 session left');
  assert.equal(planHeaderText({ todayISO: '2026-03-02', raceISO: '2026-01-01', sessions: 0 }), '0 sessions left');
  assert.equal(planHeaderText({}), '');
});
