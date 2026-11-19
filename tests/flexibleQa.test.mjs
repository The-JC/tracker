// QA tests for the flexible plan: explicit 'free' pin, cross-person pins, week events in rolling mode, pauses in Next up,
// DST / pause / race-date edge cases of the pace maths, matching edge cases.
import test from 'node:test';
import assert from 'node:assert/strict';
import { PLAN } from '../src/plan.js';
import { addDays, daysBetween, validateActivityInput, cleanSessionId, sessionPinAllowed, FREE_SESSION } from '../src/scoring.js';
import { normalizePlanState, normalizePersonState, weekStreak } from '../src/planModel.js';
import { buildSessions, matchRuns, suggestSession, sessionsDue, behindSessions, raceFeasibility, rollingWeeksFor } from '../src/rolling.js';
import { prepareEdit, formFromEntry, rollingNewlyFulfilledWeek } from '../src/utils/entryPatch.js';
import { recommendNext } from '../src/recommend.js';

process.env.TZ = 'Europe/Zurich';

const START = '2026-03-02'; // Monday; week 1 = Easy 5, Tempo 5, Long 6.5 (person a)
let seq = 0;
const e = (date, runType, km, extra = {}) => ({ id: `q${++seq}`, person: 'a', sport: 'run', runType, title: 't', date, km, hasPhoto: false, ts: 1000 + seq, ...extra });
const st = (over = {}) => normalizePersonState({ mode: 'rolling', startDate: START, ...over });
const sessions = (over = {}, person = 'a') => buildSessions(PLAN, {}, st(over), person);
const doMatch = (entries, over = {}, today = '2026-03-20') => matchRuns({ sessions: sessions(over), entries, personState: st(over), todayISO: today });

/* ---------- free pin ---------- */

test("free pin: validation accepts 'free', other ids and unknown ids behave as before", () => {
  assert.equal(cleanSessionId('free'), 'free');
  assert.equal(cleanSessionId(' free '), 'free');
  assert.equal(cleanSessionId('1-1-0-a'), '1-1-0-a');
  assert.equal(cleanSessionId('nope'), '');
  const ok = validateActivityInput({ sport: 'run', runType: 'easy', date: '2026-03-02', km: 5, session: 'free' });
  assert.equal(ok.ok, true);
  assert.equal(ok.value.session, FREE_SESSION);
  assert.equal(validateActivityInput({ sport: 'cycle', date: '2026-03-02', durationMin: 30, session: 'free' }).value.session, undefined);
});

test("free pin: a run pinned to 'free' never takes a session and stays in `free`", () => {
  const a = e('2026-03-02', 'easy', 5, { session: 'free' });
  const b = e('2026-03-03', 'easy', 5);
  const m = doMatch([a, b]);
  assert.deepEqual(m.free, [a.id]);
  assert.equal(m.byEntry[a.id], undefined);
  assert.equal(m.byEntry[b.id].sessionId, '1-1-0-a', 'the next run still takes the first easy session');
  // also not through a week override
  const imp = e(null, 'easy', 5, { week: 1, session: 'free', imported: true });
  assert.deepEqual(doMatch([imp]).free, [imp.id]);
  // order independent
  assert.deepEqual(doMatch([b, a]).byEntry, m.byEntry);
});

test("free pin: suggestSession says free (null) and pins to a person's own sessions only", () => {
  const ss = sessions();
  const m = doMatch([]);
  assert.equal(suggestSession({ person: 'a', draft: { runType: 'easy', km: 5, date: '2026-03-02', session: 'free' }, sessions: ss, match: m, entries: [], personState: st() }), null);
  assert.equal(sessionPinAllowed('free', 'a'), true);
  assert.equal(sessionPinAllowed('1-1-0-a', 'a'), true);
  assert.equal(sessionPinAllowed('1-1-0-a~r2', 'a'), true);
  assert.equal(sessionPinAllowed('1-1-0-b', 'a'), false);
  assert.equal(sessionPinAllowed('1-1-0-a', 'b'), false);
  assert.equal(sessionPinAllowed('bogus', 'a'), false);
});

test("free pin: editing a run to 'free' and back writes / removes the field; a foreign pin is dropped", () => {
  const entry = e('2026-03-02', 'easy', 5);
  const toFree = prepareEdit(entry, { ...formFromEntry(entry), session: 'free' }, { today: '2026-03-20' });
  assert.equal(toFree.ok, true); assert.deepEqual(toFree.patch, { session: 'free' });
  const back = prepareEdit(toFree.next, { ...formFromEntry(toFree.next), session: '' }, { today: '2026-03-20' });
  assert.deepEqual(back.patch, { session: null });
  const foreign = prepareEdit(entry, { ...formFromEntry(entry), session: '1-1-0-b' }, { today: '2026-03-20' });
  assert.deepEqual(foreign.patch, {}, "person a cannot pin to b's session");
  const foreignB = prepareEdit({ ...entry, person: 'b' }, { ...formFromEntry(entry), session: '1-1-0-a' }, { today: '2026-03-20' });
  assert.deepEqual(foreignB.patch, {});
});

/* ---------- matching edge cases ---------- */

test('matching: a pinned session that is later skipped releases the run to normal matching', () => {
  const pinned = e('2026-03-02', 'easy', 5, { session: '1-1-2-a' }); // pinned to the long run of week 1
  assert.equal(doMatch([pinned]).byEntry[pinned.id].sessionId, '1-1-2-a');
  const m = doMatch([pinned], { skipped: ['1-1-2-a'] });
  assert.equal(m.byEntry[pinned.id].sessionId, '1-1-0-a');
  assert.equal(m.byEntry[pinned.id].pinned, false);
});

test('matching: two runs pinned to the same session, the earlier wins, the other is matched normally', () => {
  const x = e('2026-03-02', 'easy', 5, { session: '1-1-1-a' });
  const y = e('2026-03-03', 'easy', 5, { session: '1-1-1-a' });
  const m = doMatch([y, x]);
  assert.equal(m.byEntry[x.id].sessionId, '1-1-1-a');
  assert.equal(m.byEntry[y.id].sessionId, '1-1-0-a');
});

test('matching: same-day runs are ordered by ts, id; a partial run consumes its session and is flagged', () => {
  const r1 = e('2026-03-02', 'easy', 5, { ts: 1 });
  const r2 = e('2026-03-02', 'easy', 2, { ts: 2 });
  const m = doMatch([r2, r1]);
  assert.equal(m.byEntry[r1.id].sessionId, '1-1-0-a');
  assert.equal(m.byEntry[r1.id].partial, false);
  assert.equal(m.byEntry[r2.id].partial, true, 'second easy run takes the next easy session of the queue (week 2) but is short');
});

test('matching: undated import without week stays free; run turned into a cycle disappears; other persons ignored', () => {
  const undated = e(null, 'easy', 5);
  const other = e('2026-03-02', 'easy', 5, { person: 'b' });
  const cycle = { ...e('2026-03-02', 'easy', 5), sport: 'cycle' };
  const m = matchRuns({ sessions: sessions(), entries: [undated, other, cycle], personState: st(), todayISO: '2026-03-20', person: 'a' });
  assert.deepEqual(m.free, [undated.id]);
  assert.equal(Object.keys(m.bySession).length, 0);
});

test('repeated week ids: the repeat pass has its own session id and follows the original', () => {
  const ss = sessions({ repeatWeeks: [1] });
  const wk1 = ss.filter(s => s.week === 1);
  assert.deepEqual(wk1.map(s => s.id), ['1-1-0-a', '1-1-1-a', '1-1-2-a', '1-1-0-a~r2', '1-1-1-a~r2', '1-1-2-a~r2']);
  assert.equal(new Set(ss.map(s => s.id)).size, ss.length, 'ids are unique');
  assert.equal(cleanSessionId('1-1-0-a~r2'), '1-1-0-a~r2');
});

/* ---------- week events in rolling mode ---------- */

const ROLLING_STATE = { a: { mode: 'rolling', startDate: START } };
const fulfilNow = (beforeLog, afterLog, today = '2026-03-20', planState = ROLLING_STATE) =>
  rollingNewlyFulfilledWeek({ beforeLog, afterLog, person: 'a', planState, today });

test('week event: undefined in calendar mode, week number of the SESSION in rolling mode, null when nothing new', () => {
  const l1 = e('2026-03-02', 'easy', 5), l2 = e('2026-03-03', 'tempo', 5), l3 = e('2026-03-18', 'long', 6.5); // long run 2 weeks late
  assert.equal(rollingNewlyFulfilledWeek({ beforeLog: [l1, l2], afterLog: [l1, l2, l3], person: 'a', planState: null, today: '2026-03-20' }), undefined);
  assert.equal(fulfilNow([l1, l2], [l1, l2, l3]), 1, 'dated in week 3 but completes plan week 1');
  assert.equal(fulfilNow([l1], [l1, l2]), null);
  assert.equal(fulfilNow([l1, l2, l3], [l1, l2, l3]), null, 'no change, no event');
  // a free-pinned run never completes anything
  const free = { ...l3, session: 'free' };
  assert.equal(fulfilNow([l1, l2], [l1, l2, free]), null);
  // editing a note/title on a fulfilled week does not newly fulfil
  assert.equal(fulfilNow([l1, l2, l3], [l1, l2, { ...l3, note: 'x' }]), null);
  // the other person's runs do not matter
  assert.equal(fulfilNow([l1, l2], [l1, l2, { ...l3, person: 'b' }]), null);
});

test('week event: deleting then re-adding a run reports the week again (the store dedupes via hasWeekEvent)', () => {
  const l1 = e('2026-03-02', 'easy', 5), l2 = e('2026-03-03', 'tempo', 5), l3 = e('2026-03-05', 'long', 6.5);
  assert.equal(fulfilNow([l1, l2], [l1, l2, l3]), 1);
  assert.equal(fulfilNow([l1, l2, l3], [l1, l2]), null, 'deleting never fulfils');
  assert.equal(fulfilNow([l1, l2], [l1, l2, l3]), 1);
});

/* ---------- Next up: pause ---------- */

test('Next up in rolling mode on a paused day is a rest day (no reminder), after the pause it runs again', () => {
  const plan = { a: { mode: 'rolling', startDate: START, pauses: [{ from: '2026-03-04', to: '2026-03-08', note: 'holiday' }] } };
  const during = recommendNext({ person: 'a', log: [], todayISO: '2026-03-05', planState: plan });
  assert.equal(during.kind, 'rest');
  assert.ok(during.tags.includes('Paused'));
  assert.equal(during.forDate, '2026-03-09');
  assert.match(during.reason, /paused until Sun/);
  const after = recommendNext({ person: 'a', log: [], todayISO: '2026-03-09', planState: plan });
  assert.equal(after.kind, 'run');
  // calendar mode is unaffected by the stored pause (as before)
  const cal = recommendNext({ person: 'a', log: [], todayISO: '2026-03-05', planState: { a: { ...plan.a, mode: 'calendar' } } });
  assert.equal(cal.kind, 'run');
});

/* ---------- pace maths: DST, pauses, race dates ---------- */

test('sessionsDue: DST changes (2026-03-29, 2026-10-25) never shift a day', () => {
  // start Monday 2026-03-23: week 1 passes completely on 2026-03-30 (DST began 03-29)
  const s = '2026-03-23';
  const ss = buildSessions(PLAN, {}, st({ startDate: s }), 'a');
  const due = today => sessionsDue({ sessions: ss, personState: st({ startDate: s }), startDate: s, todayISO: today }).due;
  assert.equal(due('2026-03-29'), 0, 'Sunday: week 1 not over yet');
  assert.equal(due('2026-03-30'), 3, 'Monday: week 1 complete');
  // autumn: start Monday 2026-10-19, week 1 over on 2026-10-26 (DST ended 10-25)
  const s2 = '2026-10-19';
  const ss2 = buildSessions(PLAN, {}, st({ startDate: s2 }), 'a');
  const due2 = t => sessionsDue({ sessions: ss2, personState: st({ startDate: s2 }), startDate: s2, todayISO: t }).due;
  assert.equal(due2('2026-10-25'), 0);
  assert.equal(due2('2026-10-26'), 3);
  assert.equal(daysBetween('2026-10-24', '2026-10-26'), 2);
});

test('sessionsDue: a pause spanning week boundaries shifts every later week; raceDate equal to today, before start, in the past', () => {
  const pauses = [{ from: '2026-03-05', to: '2026-03-14' }]; // 10 days across two week boundaries
  const base = { sessions: sessions({ pauses }), personState: st({ pauses }), startDate: START };
  // 2026-03-16 = day 14 elapsed, 10 paused -> 4 active days: nothing due yet
  assert.equal(sessionsDue({ ...base, todayISO: '2026-03-16' }).due, 0);
  // 7 active days elapsed: 4 + 3 more days after the pause -> 2026-03-19 (elapsed 17, paused 10 -> 7)
  assert.equal(sessionsDue({ ...base, todayISO: '2026-03-19' }).due, 3);
  // race date equals today: race session not due, others spread
  const race = '2026-06-01';
  const rs = { sessions: sessions({ raceDate: race }), personState: st({ raceDate: race }), startDate: START };
  const d = sessionsDue({ ...rs, todayISO: race });
  assert.equal(d.basis, 'race');
  assert.ok(d.due <= d.total - 1);
  assert.equal(sessionsDue({ ...rs, todayISO: addDays(race, 1) }).due, d.total, 'after the race everything is due');
  // race before start -> calendar basis, no crash
  const early = { sessions: sessions({ raceDate: '2026-02-01' }), personState: st({ raceDate: '2026-02-01' }), startDate: START };
  assert.equal(sessionsDue({ ...early, todayISO: '2026-03-20' }).basis, 'calendar');
  // behind is never negative even when more is done than due
  const m = doMatch([e('2026-03-02', 'easy', 5)], {}, '2026-03-03');
  assert.equal(behindSessions({ sessions: sessions(), match: m, personState: st(), startDate: START, todayISO: '2026-03-03' }), 0);
});

test('raceFeasibility: race today, fewer slots than sessions, past race, ranToday', () => {
  const today = '2026-03-20';
  const mk = (raceDate, over = {}) => {
    const ps = st({ raceDate, ...over });
    const ss = buildSessions(PLAN, {}, ps, 'a');
    const m = matchRuns({ sessions: ss, entries: [], personState: ps, todayISO: today });
    return raceFeasibility({ sessions: ss, match: m, personState: ps, todayISO: today });
  };
  const t = mk(today);
  assert.equal(t.daysLeft, 0); assert.equal(t.slots, 1); assert.equal(t.fits, false); assert.ok(t.shortBy > 0);
  const past = mk('2026-03-01');
  assert.equal(past.daysLeft, 0); assert.equal(past.slots, 0);
  assert.equal(mk('2027-12-31').fits, true);
  assert.equal(raceFeasibility({ sessions: [], match: null, personState: st(), todayISO: today }), null);
});

/* ---------- week streak with pauses, both modes ---------- */

test('week streak: a paused week neither counts nor breaks the streak, in both modes', () => {
  const log = [
    e('2026-03-02', 'easy', 5), e('2026-03-04', 'tempo', 5), e('2026-03-07', 'long', 6.5),      // week of 03-02 counted
    // week of 03-09 paused, week of 03-16 counted
    e('2026-03-16', 'easy', 5), e('2026-03-18', 'tempo', 5), e('2026-03-21', 'long', 6.5)
  ];
  for (const mode of ['calendar', 'rolling']) {
    const state = { a: { mode, startDate: START, pauses: [{ from: '2026-03-09', to: '2026-03-15' }] } };
    const s = weekStreak({ log, person: 'a', state, plan: PLAN, todayISO: '2026-03-23' });
    assert.equal(s.current, 2, mode);
    const noPause = weekStreak({ log, person: 'a', state: { a: { mode, startDate: START } }, plan: PLAN, todayISO: '2026-03-23' });
    assert.equal(noPause.current, 1, `${mode}: without the pause the empty week breaks the streak`);
  }
});

/* ---------- rolling weeks never 'missed' ---------- */

test("rolling weeks: no week is ever 'missed', even months behind", () => {
  const v = rollingWeeksFor({ log: [], person: 'a', state: st(), startDate: START, todayISO: '2026-11-19' });
  assert.ok(v.weeks.every(w => w.status !== 'missed'));
  assert.equal(v.weeks.filter(w => w.status === 'current').length, 1);
  assert.ok(v.behindSessions > 0);
});

/* ---------- plans of both persons stay separate ---------- */

test('normalizePlanState keeps a and b separate', () => {
  const s = normalizePlanState({ a: { mode: 'rolling', skipped: ['w1-easy'] }, b: {} });
  assert.equal(s.a.mode, 'rolling'); assert.equal(s.b.mode, 'calendar'); assert.deepEqual(s.b.skipped, []);
});
