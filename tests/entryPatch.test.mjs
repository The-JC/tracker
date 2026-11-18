import test from 'node:test';
import assert from 'node:assert/strict';
import { PLAN } from '../src/plan.js';
import { buildWeeks } from '../src/scoring.js';
import {
  formFromEntry, isAutoTitle, changeSport, applyPatch, prepareEdit, newlyFulfilledWeek, hasWeekEvent, weekFulfillment, FUTURE_DATE_ERROR
} from '../src/utils/entryPatch.js';

const TODAY = '2026-03-20';
const run = (o = {}) => ({
  id: 'r1', person: 'a', sport: 'run', runType: 'easy', title: 'Morning run', date: '2026-03-09', km: 5,
  hasPhoto: false, ts: 100, kudos: { b: true }, ...o
});
const edit = (entry, over = {}, opts = {}) => prepareEdit(entry, { ...formFromEntry(entry), ...over }, { today: TODAY, ...opts });

test('formFromEntry gives strings and empty date for undated imports', () => {
  const f = formFromEntry({ sport: 'run', km: 5.5, durationMin: 30, date: null, title: 'Week 2 · Easy' });
  assert.deepEqual(f, { sport: 'run', runType: 'easy', date: '', km: '5.5', durationMin: '30', title: 'Week 2 · Easy', note: '' });
});

test('an untouched form produces an empty patch and no change', () => {
  const r = edit(run());
  assert.equal(r.ok, true);
  assert.deepEqual(r.patch, {});
  assert.equal(r.changed, false);
  assert.equal(r.photo, 'keep');
});

test('only changed fields land in the patch', () => {
  const r = edit(run(), { km: '8,2', date: '2026-03-10' });
  assert.deepEqual(r.patch, { km: 8.2, date: '2026-03-10' });
  assert.equal(r.next.km, 8.2);
  assert.equal(r.next.person, 'a');
  assert.deepEqual(r.next.kudos, { b: true });
});

test('patch never contains person, id, ts, kudos, imported or editedTs', () => {
  const r = edit(run({ imported: true }), { km: '9', title: 'x', note: 'n', durationMin: '50', runType: 'long', date: '2026-03-11' });
  for (const k of ['person', 'id', 'ts', 'kudos', 'imported', 'editedTs']) assert.equal(k in r.patch, false);
});

test('clearing optional fields removes them (null)', () => {
  const r = edit(run({ note: 'hello', durationMin: 30 }), { note: '', durationMin: '' });
  assert.deepEqual(r.patch, { note: null, durationMin: null });
  assert.equal('note' in r.next, false);
});

test('changing sport drops the fields that no longer apply', () => {
  const r = edit(run({ durationMin: 60 }), { sport: 'cycle', km: '', runType: 'easy', title: '' });
  assert.equal(r.ok, true);
  assert.equal(r.patch.sport, 'cycle');
  assert.equal(r.patch.km, null);
  assert.equal(r.patch.runType, null);
  assert.match(r.patch.title, /ride$/);
  assert.equal(r.next.km, undefined);
  // even if the form still carried them
  const r2 = edit(run({ durationMin: 60 }), { sport: 'cycle' });
  assert.equal(r2.patch.km, null);
  assert.equal(r2.patch.runType, null);
});

test('changeSport clears runType, km and auto titles but keeps duration, date, note', () => {
  const f = { sport: 'run', runType: 'tempo', date: '2026-03-01', km: '5', durationMin: '30', title: 'Evening run', note: 'n' };
  assert.deepEqual(changeSport(f, 'swim'), { sport: 'swim', runType: 'easy', date: '2026-03-01', km: '', durationMin: '30', title: '', note: 'n' });
  assert.equal(changeSport({ ...f, title: 'Park loop' }, 'hike').title, 'Park loop');
  assert.equal(changeSport(f, 'hike').km, '5');
  assert.equal(changeSport(f, 'hike').runType, 'easy');
  assert.equal(changeSport(f, 'run'), f);
});

test('isAutoTitle recognises generated titles of the sport only', () => {
  assert.equal(isAutoTitle('Morning run', 'run'), true);
  assert.equal(isAutoTitle('Night run', 'run'), true);
  assert.equal(isAutoTitle('Morning run', 'cycle'), false);
  assert.equal(isAutoTitle('Park loop', 'run'), false);
  assert.equal(isAutoTitle('', 'run'), true);
});

test('validation is the same as creating an entry', () => {
  assert.equal(edit(run(), { km: '' }).ok, false);               // run needs distance
  assert.match(edit(run(), { km: '-3' }).error, /Distance/);
  assert.equal(edit(run(), { km: 'abc' }).ok, false);
  assert.equal(edit(run({ sport: 'swim', km: undefined, durationMin: 20 }), { durationMin: '' }).ok, false);
  assert.equal(edit(run(), { date: 'nope' }).ok, false);
  assert.equal(edit(run(), { sport: 'zzz' }).ok, false);
});

test('a date in the future is rejected', () => {
  const r = edit(run(), { date: '2026-03-21' });
  assert.equal(r.ok, false);
  assert.equal(r.error, FUTURE_DATE_ERROR);
  assert.equal(edit(run(), { date: TODAY }).ok, true);
});

test('undated imported entries may stay undated or get a real date', () => {
  const imp = run({ date: null, week: 4, imported: true, title: 'Week 4 · Easy' });
  const same = edit(imp, { note: 'hi' });
  assert.equal(same.ok, true);
  assert.deepEqual(same.patch, { note: 'hi' });
  assert.equal(same.next.date, null);

  const dated = edit(imp, { date: '2026-03-12' });
  assert.deepEqual(dated.patch, { date: '2026-03-12', week: null }, 'the week override gives way to the real date');
  assert.equal('week' in dated.next, false);
  assert.equal(dated.next.imported, true);
});

test('photo handling keeps hasPhoto consistent', () => {
  const withPhoto = run({ hasPhoto: true });
  assert.deepEqual(prepareEdit(withPhoto, { ...formFromEntry(withPhoto) }, { today: TODAY }).patch, {});
  const added = prepareEdit(run(), { ...formFromEntry(run()), photoDataUrl: 'data:image/jpeg;base64,AA' }, { today: TODAY });
  assert.equal(added.photo, 'set');
  assert.equal(added.patch.hasPhoto, true);
  assert.equal(added.changed, true);
  const replaced = prepareEdit(withPhoto, { ...formFromEntry(withPhoto), photoDataUrl: 'data:image/jpeg;base64,AB' }, { today: TODAY });
  assert.equal(replaced.photo, 'set');
  assert.equal('hasPhoto' in replaced.patch, false);
  assert.equal(replaced.changed, true, 'replacing only the photo still counts as a change');
  const removed = prepareEdit(withPhoto, { ...formFromEntry(withPhoto), removePhoto: true }, { today: TODAY });
  assert.equal(removed.photo, 'remove');
  assert.equal(removed.patch.hasPhoto, false);
  const noop = prepareEdit(run(), { ...formFromEntry(run()), removePhoto: true }, { today: TODAY });
  assert.equal(noop.photo, 'keep');
  assert.equal(noop.changed, false);
});

test('applyPatch removes null fields', () => {
  assert.deepEqual(applyPatch({ a: 1, b: 2 }, { a: null, c: 3 }), { b: 2, c: 3 });
});

/* ---------- newly fulfilled week ---------- */

// Week 1 of person a: find its planned km so the tests do not hard-code the plan.
const START = '2026-03-02'; // a Monday: week 1 = 03-02..03-08
const goals = {};
const planned = buildWeeks(PLAN, goals, [], START, TODAY)[0].a.plannedKm;

test('planned km of week 1 is positive (test precondition)', () => assert.ok(planned > 0));

function crossing(entry, over, extra = []) {
  const r = prepareEdit(entry, { ...formFromEntry(entry), ...over }, { today: TODAY });
  assert.equal(r.ok, true, r.error);
  return newlyFulfilledWeek({
    entry, next: r.next, log: [entry, ...extra], goals, settingsStartDate: START, today: TODAY
  });
}

test('raising km so the week reaches 100% is a crossing', () => {
  const e = run({ date: '2026-03-03', km: 1 });
  assert.equal(crossing(e, { km: String(planned) }), 1);
});

test('moving a run into a week that is thereby fulfilled is a crossing', () => {
  const e = run({ date: '2026-03-10', km: planned }); // week 2
  assert.equal(crossing(e, { date: '2026-03-04' }), 1);
});

test('already fulfilled before the edit is not a crossing', () => {
  const e = run({ date: '2026-03-03', km: planned });
  assert.equal(crossing(e, { km: String(planned + 2) }), null);
  const other = run({ id: 'r2', date: '2026-03-04', km: planned });
  assert.equal(crossing(run({ date: '2026-03-03', km: 1 }), { km: '2' }, [other]), null);
});

test('edits that stay short, or other sports / other people, are not a crossing', () => {
  assert.equal(crossing(run({ date: '2026-03-03', km: 1 }), { km: '2' }), null);
  assert.equal(crossing(run({ date: '2026-03-03', km: 1 }), { sport: 'hike', km: String(planned) }), null);
});

test('hasWeekEvent matches person and week, not the name', () => {
  const events = [{ kind: 'week', actor: 'a', text: 'Beatrix completed week 3 🎉' }, { kind: 'activity', actor: 'a', text: 'x' }];
  assert.equal(hasWeekEvent(events, 'a', 3), true);
  assert.equal(hasWeekEvent(events, 'b', 3), false);
  assert.equal(hasWeekEvent(events, 'a', 13), false);
  assert.equal(hasWeekEvent(events, 'a', 4), false);
  assert.equal(hasWeekEvent([], 'a', 3), false);
});

/* ---------- weekFulfillment: out-of-plan dates must never throw (regression: "undefined is not an object (evaluating 'l[n]')") ---------- */

test('weekFulfillment: a run dated before an explicit plan start is outside the plan, not a crash', () => {
  const entry = run({ id: 'new', date: '2026-02-02', km: 4 });
  const res = weekFulfillment({ entry, log: [entry], person: 'a', settingsStartDate: '2026-03-02', today: TODAY });
  assert.deepEqual(res, { n: null, done: false });
});

test('weekFulfillment: far in the past (week <= 0) and after the race are outside the plan', () => {
  for (const date of ['2025-01-01', '2026-03-01', '2027-06-01']) {
    const entry = run({ id: 'x', date });
    assert.doesNotThrow(() => weekFulfillment({ entry, log: [entry], person: 'a', settingsStartDate: '2026-03-02', today: TODAY }));
    assert.equal(weekFulfillment({ entry, log: [entry], person: 'a', settingsStartDate: '2026-03-02', today: TODAY }).n, null);
  }
});

test('weekFulfillment: a run inside the plan reports its week and fulfilment', () => {
  const week1 = PLAN[0].runs.a.reduce((s, r) => s + (r.km || 0), 0);
  const entry = run({ id: 'full', date: '2026-03-04', km: week1 });
  const res = weekFulfillment({ entry, log: [entry], person: 'a', settingsStartDate: '2026-03-02', today: TODAY });
  assert.equal(res.n, 1);
  assert.equal(res.done, true);
  const small = weekFulfillment({ entry: run({ id: 's', date: '2026-03-04', km: 1 }), log: [run({ id: 's', date: '2026-03-04', km: 1 })], person: 'a', settingsStartDate: '2026-03-02', today: TODAY });
  assert.deepEqual(small, { n: 1, done: false });
});

test('weekFulfillment: without an explicit start the earliest run defines week 1 (never negative)', () => {
  const early = run({ id: 'e', date: '2026-03-02' });
  const late = run({ id: 'l', date: '2026-03-18' });
  assert.equal(weekFulfillment({ entry: late, log: [early, late], person: 'a', today: TODAY }).n, 3);
  assert.equal(weekFulfillment({ entry: early, log: [early, late], person: 'a', today: TODAY }).n, 1);
});

test('newlyFulfilledWeek: does not throw when the edit moves a run before the plan start', () => {
  const entry = run({ id: 'm', date: '2026-03-04', km: 20 });
  const next = { ...entry, date: '2026-01-05' };
  assert.doesNotThrow(() => newlyFulfilledWeek({ entry, next, log: [entry], settingsStartDate: '2026-03-02', today: TODAY }));
});
