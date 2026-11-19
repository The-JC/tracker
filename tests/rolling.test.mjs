import test from 'node:test';
import assert from 'node:assert/strict';
import { PLAN } from '../src/plan.js';
import { addDays, daysBetween } from '../src/scoring.js';
import { normalizePersonState, normalizePlanState, validatePlanPatch, buildWeeksFor, weekStreak } from '../src/planModel.js';
import {
  buildSessions, matchRuns, suggestSession, explainMatch, sessionLabel, sessionsDue, behindSessions, raceFeasibility,
  rollingWeeksFor, rollingStateFor, nextOpenSession, skipSessionPatch, unskipSessionPatch, repeatWeekPatch, unrepeatWeekPatch,
  addPausePatch, removePausePatch, previewModeSwitch, ROLLING_LOOKAHEAD, DONE_THRESHOLD
} from '../src/rolling.js';
import { DONE_THRESHOLD as RECOMMEND_THRESHOLD } from '../src/recommend.js';

// Dates are strings and all arithmetic is UTC based; prove the zone (with DST changes) does not matter.
process.env.TZ = 'Europe/Zurich';

const START = '2026-03-02'; // a Monday
let seq = 0;
const e = (date, runType, km, extra = {}) => ({ id: `e${++seq}`, person: 'a', sport: 'run', runType, title: 't', date, km, hasPhoto: false, ts: 1000 + seq, ...extra });
const state = (over = {}) => normalizePersonState({ mode: 'rolling', startDate: START, ...over });
const sessionsOf = (over = {}, person = 'a', goals = {}) => buildSessions(PLAN, goals, state(over), person);
const match = (entries, over = {}, extra = {}) => {
  const st = state(over);
  return matchRuns({ sessions: buildSessions(PLAN, {}, st, 'a'), entries, personState: st, todayISO: '2026-03-12', ...extra });
};
const sess = (id, over = {}) => sessionsOf(over).find(s => s.id === id);
const matchedIds = m => Object.keys(m.bySession);

// A log that does the first n sessions of the queue exactly, one every two days from `from`.
function perfect(n, from = START, over = {}) {
  const list = sessionsOf(over).filter(s => !s.skipped).slice(0, n);
  return list.map((s, i) => e(addDays(from, i * 2), s.runType, s.km > 0 ? s.km : 2));
}

// deterministic PRNG for the property tests
function rng(seed) {
  let t = seed >>> 0;
  return () => {
    t = (t + 0x6d2b79f5) >>> 0;
    let r = Math.imul(t ^ (t >>> 15), 1 | t);
    r = (r + Math.imul(r ^ (r >>> 7), 61 | r)) ^ r;
    return ((r ^ (r >>> 14)) >>> 0) / 4294967296;
  };
}
const pick = (rand, list) => list[Math.floor(rand() * list.length)];
const shuffled = (rand, list) => { const a = [...list]; for (let i = a.length - 1; i > 0; i--) { const j = Math.floor(rand() * (i + 1)); [a[i], a[j]] = [a[j], a[i]]; } return a; };
function randomLog(rand, { n = 12, pins = false, types = ['easy', 'tempo', 'long', 'easy', 'shakeout', 'race', 'speed', undefined] } = {}) {
  const sessionIds = sessionsOf().map(s => s.id);
  return Array.from({ length: n }, () => {
    const extra = {};
    if (pins && rand() < 0.2) extra.session = pick(rand, sessionIds);
    return e(addDays('2026-03-02', Math.floor(rand() * 60)), pick(rand, types), Math.round((2 + rand() * 12) * 10) / 10, { ts: Math.floor(rand() * 5), ...extra });
  });
}

/* ---------- constants ---------- */

test('the done threshold is shared with recommend.js', () => {
  assert.equal(DONE_THRESHOLD, 0.9);
  assert.equal(RECOMMEND_THRESHOLD, DONE_THRESHOLD);
  assert.equal(ROLLING_LOOKAHEAD, 6);
});

/* ---------- repeatWeeks in the plan state ---------- */

test('repeatWeeks: sorted, unique, integers within the plan; invalid values dropped', () => {
  assert.deepEqual(normalizePersonState({ repeatWeeks: [7, 3, 7, '5', 0, 31, 1.5, 'x', null, 30, 1] }).repeatWeeks, [1, 3, 5, 7, 30]);
  assert.deepEqual(normalizePersonState({ repeatWeeks: 'no' }).repeatWeeks, []);
  assert.deepEqual(normalizePersonState({}).repeatWeeks, []);
  const once = normalizePlanState({ a: { repeatWeeks: [9, 2] } });
  assert.deepEqual(normalizePlanState(once), once);
});

test('validatePlanPatch: repeatWeeks is strict, null clears', () => {
  assert.deepEqual(validatePlanPatch({ repeatWeeks: [4, 2, 4] }), { ok: true, patch: { repeatWeeks: [2, 4] } });
  assert.deepEqual(validatePlanPatch({ repeatWeeks: null }), { ok: true, patch: { repeatWeeks: [] } });
  for (const bad of [[0], [31], ['x'], 'a', [1.5]]) assert.equal(validatePlanPatch({ repeatWeeks: bad }).ok, false);
});

/* ---------- sessions ---------- */

test('buildSessions flattens the plan of one person in order', () => {
  const s = sessionsOf();
  assert.equal(s.length, PLAN.reduce((n, w) => n + w.runs.a.length, 0));
  assert.deepEqual(s.slice(0, 4).map(x => [x.id, x.week, x.index, x.runType, x.km]),
    [['1-1-0-a', 1, 0, 'easy', 5], ['1-1-1-a', 1, 1, 'tempo', 5], ['1-1-2-a', 1, 2, 'long', 6.5], ['1-2-0-a', 2, 3, 'easy', 5]]);
  assert.ok(s.every((x, i) => x.index === i && x.runId === x.id && !x.repeat && !x.skipped));
  const first = s[1];
  assert.deepEqual(Object.keys(first).sort(), ['detail', 'id', 'index', 'km', 'mult', 'optional', 'repeat', 'runId', 'runType', 'skipped', 'type', 'week']);
  assert.equal(first.detail, '4×2 min pickups');
  assert.equal(first.mult, 1.6);
  // person b has its own ids; the object form and the { a, b } states work too
  assert.equal(sessionsOf({}, 'b')[0].id, '1-1-0-b');
  assert.deepEqual(buildSessions({ plan: PLAN, goals: {}, state: state(), person: 'b' }), sessionsOf({}, 'b'));
  assert.deepEqual(buildSessions(PLAN, {}, { a: state(), b: state({ repeatWeeks: [2] }) }, 'b').length, s.length + 3);
});

test('buildSessions: optional = no km goal, goals override km (also from 0), keyed by the original run id', () => {
  const s = sessionsOf();
  const shake = s.find(x => x.runType === 'shakeout');
  assert.equal(shake.optional, true);
  assert.equal(shake.km, 0);
  assert.equal(s[0].optional, false);
  const g = sessionsOf({ repeatWeeks: [1] }, 'a', { '1-1-0-a': '7', '1-1-1-a': '0' });
  assert.equal(g[0].km, 7);
  assert.equal(g[1].optional, true, 'a goal of 0 makes the session optional');
  const rep = g.find(x => x.id === '1-1-0-a~r2');
  assert.equal(rep.km, 7, 'the repeat pass uses the goal of the original run');
});

test('buildSessions: repeated weeks come right after the original week with the ~r2 suffix', () => {
  const s = sessionsOf({ repeatWeeks: [2, 1] });
  assert.deepEqual(s.slice(0, 9).map(x => x.id + (x.repeat ? '*' : '')),
    ['1-1-0-a', '1-1-1-a', '1-1-2-a', '1-1-0-a~r2*', '1-1-1-a~r2*', '1-1-2-a~r2*', '1-2-0-a', '1-2-1-a', '1-2-2-a']);
  assert.equal(s.length, sessionsOf().length + 6);
  assert.ok(s.every((x, i) => x.index === i));
  assert.equal(new Set(s.map(x => x.id)).size, s.length);
  assert.equal(sessionLabel(s[3]), 'Easy · Week 1 (repeat)');
  assert.equal(sessionLabel(s[0]), 'Easy · Week 1');
});

test('buildSessions: skipped by run id or w<week>-<runType> alias, repeat pass separately; kept in the list', () => {
  const s = sessionsOf({ skipped: ['1-1-0-a', 'w2-tempo'], repeatWeeks: [1] });
  assert.equal(s[0].skipped, true);
  assert.equal(s.find(x => x.id === '1-1-0-a~r2').skipped, false, 'skipping the original keeps its repeat pass');
  assert.equal(s.find(x => x.id === '1-2-1-a').skipped, true);
  assert.equal(s.find(x => x.id === '1-2-0-a').skipped, false);
  const alias = sessionsOf({ skipped: ['w1-easy~r2'], repeatWeeks: [1] });
  assert.equal(alias.find(x => x.id === '1-1-0-a~r2').skipped, true);
  assert.equal(alias[0].skipped, false);
  assert.equal(s.length, sessionsOf({ repeatWeeks: [1] }).length);
});

/* ---------- matching: hand-made scenarios ---------- */

test('matchRuns: runs take the earliest unmatched session of their run type', () => {
  const m = match([e('2026-03-02', 'easy', 5), e('2026-03-04', 'easy', 5), e('2026-03-05', 'tempo', 5.2)]);
  assert.deepEqual(m.byEntry[`e${seq - 2}`], { sessionId: '1-1-0-a', week: 1, partial: false, pinned: false });
  assert.equal(m.bySession['1-2-0-a'].entryId, `e${seq - 1}`, 'the second easy run takes the next easy session, which is in week 2');
  assert.equal(m.bySession['1-1-1-a'].entryId, `e${seq}`);
  assert.deepEqual(m.free, []);
  assert.equal(m.doneCount, 3);
  assert.equal(m.partialCount, 0);
  assert.equal(m.firstOpenIndex, 2, 'the long run of week 1 is the first open session');
  assert.equal(m.totalCount, 89);
  assert.equal(m.openCount, 86);
});

test('matchRuns: the result shape and the order of runs by (date, ts, id)', () => {
  const a = e('2026-03-03', 'easy', 5, { id: 'zz', ts: 5 });
  const b = e('2026-03-03', 'easy', 5, { id: 'aa', ts: 5 });
  const c = e('2026-03-03', 'easy', 5, { id: 'mm', ts: 1 });
  const m = match([a, b, c]);
  assert.equal(m.bySession['1-1-0-a'].entryId, 'mm', 'lowest ts first');
  assert.equal(m.bySession['1-2-0-a'].entryId, 'aa', 'then id');
  assert.equal(m.bySession['1-3-0-a'].entryId, 'zz');
  for (const k of ['bySession', 'byEntry', 'free', 'firstOpenIndex', 'doneCount', 'partialCount', 'openCount', 'totalCount', 'behind', 'lookahead']) assert.ok(k in m, k);
});

test('matchRuns: a run below 90% of the km is partial but still consumes the session', () => {
  const m = match([e('2026-03-02', 'easy', 4.5), e('2026-03-03', 'easy', 4.49)]);
  assert.equal(m.bySession['1-1-0-a'].partial, false, '90% is done (inclusive)');
  assert.equal(m.bySession['1-2-0-a'].partial, true);
  assert.equal(m.byEntry[m.bySession['1-2-0-a'].entryId].partial, true);
  assert.equal(m.doneCount, 1);
  assert.equal(m.partialCount, 1);
  assert.equal(m.openCount, 87);
  assert.equal(m.firstOpenIndex, 1, 'partial sessions do not hold the queue');
});

test('matchRuns: lookahead boundaries (default 6, parameter, run type outside it stays free)', () => {
  // queue of week 1-3: easy tempo long easy tempo long easy ...; a long run is in the window of 3 and of 2 only after nothing else
  const long = [e('2026-03-02', 'long', 9)];
  assert.equal(match(long, {}, { lookahead: 3 }).bySession['1-1-2-a'].entryId, long[0].id);
  assert.deepEqual(match(long, {}, { lookahead: 2 }).free, [long[0].id]);
  assert.equal(Object.keys(match(long, {}, { lookahead: 2 }).bySession).length, 0);
  // default 6: the 6th unmatched session is reachable, the 7th is not (race is far away: always free)
  const race = [e('2026-03-02', 'race', 21)];
  assert.deepEqual(match(race).free, [race[0].id]);
  // the window slides: the 7th session becomes reachable after the first run
  const sevenths = sessionsOf().filter(s => s.runType === 'easy');
  assert.equal(sevenths[2].index, 6);
  const m = match([e('2026-03-02', 'tempo', 5), e('2026-03-03', 'easy', 5), e('2026-03-04', 'easy', 5), e('2026-03-05', 'easy', 5)]);
  assert.equal(m.bySession['1-3-0-a'].entryId, `e${seq}`, 'easy #3 sits at index 6 which is in the window once a tempo run was matched');
  assert.equal(match([e('2026-03-02', 'easy', 5), e('2026-03-03', 'easy', 5), e('2026-03-04', 'easy', 5)]).bySession['1-3-0-a'].entryId, `e${seq}`, 'window of six unmatched sessions from index 2 reaches index 6');
  assert.equal(match([e('2026-03-02', 'easy', 5, { id: 'x1' })], {}, { lookahead: 1 }).bySession['1-1-0-a'].entryId, 'x1');
  assert.deepEqual(match([e('2026-03-02', 'tempo', 5, { id: 'x2' })], {}, { lookahead: 1 }).free, ['x2']);
});

test('matchRuns: an untyped run takes the session with the closest km within the lookahead', () => {
  const m = match([e('2026-03-02', undefined, 6.4, { id: 'u1' }), e('2026-03-03', 'jog', 5.1, { id: 'u2' })]);
  assert.equal(m.byEntry.u1.sessionId, '1-1-2-a', '6.4 km is closest to the 6.5 km long run');
  assert.equal(m.byEntry.u2.sessionId, '1-1-0-a', 'unknown run type: closest km (5 km, earliest of the 5 km sessions)');
});

test('matchRuns: runs that match nothing stay free; only runs of the person with km count', () => {
  const entries = [
    e('2026-03-02', 'race', 21, { id: 'f1' }), e('2026-03-02', 'easy', 5, { id: 'h', sport: 'hike' }), e('2026-03-02', 'easy', 0, { id: 'z' }),
    e('2026-03-02', 'easy', 5, { id: 'o', person: 'b' }), e('2026-03-02', 'easy', 5, { id: 'ok' })
  ];
  const m = match(entries, {}, { person: 'a' });
  assert.deepEqual(m.free, ['f1']);
  assert.deepEqual(matchedIds(m), ['1-1-0-a']);
  assert.equal(m.byEntry.ok.sessionId, '1-1-0-a');
  assert.equal(m.byEntry.o, undefined);
});

test('matchRuns: pins win over order, are ignored when the session does not exist or is held by an earlier pin', () => {
  const early = e('2026-03-02', 'tempo', 5, { id: 'early' });
  const pinned = e('2026-03-20', 'tempo', 5, { id: 'pinned', session: '1-1-1-a' });
  const m = match([early, pinned]);
  assert.equal(m.byEntry.pinned.sessionId, '1-1-1-a');
  assert.equal(m.byEntry.pinned.pinned, true);
  assert.equal(m.byEntry.early.sessionId, '1-2-1-a', 'the earlier run does not take the pinned session');
  // a pin may leave the lookahead and the run type
  const far = e('2026-03-02', 'easy', 5, { id: 'far', session: '1-9-1-a' });
  assert.equal(match([far]).byEntry.far.sessionId, '1-9-1-a');
  assert.equal(match([far]).firstOpenIndex, 0);
  // unknown session / other person's session / skipped session: the pin is ignored and normal matching applies
  assert.equal(match([e('2026-03-02', 'easy', 5, { id: 'p1', session: 'nope' })]).byEntry.p1.sessionId, '1-1-0-a');
  assert.equal(match([e('2026-03-02', 'easy', 5, { id: 'p2', session: '1-1-1-b' })]).byEntry.p2.sessionId, '1-1-0-a');
  const sk = match([e('2026-03-02', 'easy', 5, { id: 'p3', session: '1-1-0-a' })], { skipped: ['1-1-0-a'] });
  assert.equal(sk.byEntry.p3.sessionId, '1-2-0-a');
  assert.equal(sk.byEntry.p3.pinned, false);
  // two runs pinned to one session: the first by (date, ts, id) holds it, the other falls back to matching
  const two = match([e('2026-03-05', 'easy', 5, { id: 'b2', session: '1-1-0-a' }), e('2026-03-03', 'easy', 5, { id: 'b1', session: '1-1-0-a' })]);
  assert.equal(two.byEntry.b1.sessionId, '1-1-0-a');
  assert.equal(two.byEntry.b2.sessionId, '1-2-0-a');
  assert.equal(two.byEntry.b2.pinned, false);
});

test('matchRuns: skipped sessions are removed from the queue and never matched', () => {
  const m = match([e('2026-03-02', 'easy', 5, { id: 'a1' }), e('2026-03-03', 'tempo', 5, { id: 'a2' })], { skipped: ['1-1-0-a', 'w1-tempo'] });
  assert.equal(m.byEntry.a1.sessionId, '1-2-0-a');
  assert.equal(m.byEntry.a2.sessionId, '1-2-1-a');
  assert.equal(m.totalCount, 87);
  assert.equal(m.firstOpenIndex, 2, 'the first open session is the long run (the skipped ones are not open)');
  assert.equal(match([], { skipped: ['1-1-0-a', '1-1-1-a', '1-1-2-a'] }).firstOpenIndex, 3);
});

test('matchRuns: repeated weeks add a second pass of sessions', () => {
  const log = perfect(3).concat([e('2026-03-12', 'easy', 5, { id: 'again' })]);
  const m = match(log, { repeatWeeks: [1] });
  assert.equal(m.byEntry.again.sessionId, '1-1-0-a~r2');
  assert.equal(m.byEntry.again.week, 1);
  assert.equal(m.totalCount, 92);
  assert.equal(m.firstOpenIndex, 4);
  const noRepeat = match(log);
  assert.equal(noRepeat.byEntry.again.sessionId, '1-2-0-a');
});

test('matchRuns: undated imports with a week override map into that week by run type, then by km', () => {
  const imports = [
    e(null, 'long', 8, { id: 'i1', week: 3, ts: 1 }), e(null, 'easy', 5.5, { id: 'i2', week: 3, ts: 2 }),
    e(null, 'speed', 5.4, { id: 'i3', week: 3, ts: 3 }), e(null, 'easy', 5, { id: 'i4', week: 40, ts: 4 }), e(null, 'easy', 5, { id: 'i5', ts: 5 })
  ];
  const m = match(imports);
  assert.equal(m.byEntry.i1.sessionId, '1-3-2-a');
  assert.equal(m.byEntry.i2.sessionId, '1-3-0-a');
  assert.equal(m.byEntry.i3.sessionId, '1-3-1-a', 'a type the week does not have: the open session with the closest km');
  assert.deepEqual(m.free, ['i4', 'i5'], 'a week outside the plan and an undated run without a week stay free');
  assert.equal(m.firstOpenIndex, 0);
  assert.equal(m.partialCount, 0);
  // dated runs are matched around the imports
  const mixed = match([...imports, e('2026-03-02', 'easy', 5, { id: 'd1' })]);
  assert.equal(mixed.byEntry.d1.sessionId, '1-1-0-a');
});

test('matchRuns: deterministic and idempotent', () => {
  const rand = rng(7);
  const log = randomLog(rand, { n: 25, pins: true });
  const a = match(log);
  assert.deepEqual(match(log), a);
  assert.deepEqual(match(JSON.parse(JSON.stringify(log))), a);
  assert.equal(JSON.stringify(match(log)), JSON.stringify(a));
});

/* ---------- matching: property tests ---------- */

const cmpEntry = (x, y) => (x.date || '').localeCompare(y.date || '') || (x.ts || 0) - (y.ts || 0) || String(x.id).localeCompare(String(y.id));

test('property: the result does not depend on the input order, and is consistent', () => {
  for (let seed = 1; seed <= 150; seed++) {
    const rand = rng(seed);
    const log = randomLog(rand, { n: 3 + Math.floor(rand() * 25), pins: seed % 2 === 0 });
    if (seed % 5 === 0) log.push(e(null, pick(rand, ['easy', 'long']), 5, { week: 1 + Math.floor(rand() * 5) }));
    const over = seed % 3 === 0 ? { skipped: ['w2-tempo', '1-3-0-a'], repeatWeeks: [1, 4] } : {};
    const base = match(log, over);
    assert.deepEqual(match(shuffled(rand, log), over), base, `seed ${seed}`);
    assert.deepEqual(match([...log].reverse(), over), base, `seed ${seed}`);
    // consistency: bijection between matched sessions and entries, free = the rest
    const entryIds = Object.keys(base.byEntry);
    assert.equal(entryIds.length, matchedIds(base).length);
    for (const [sid, m] of Object.entries(base.bySession)) assert.equal(base.byEntry[m.entryId].sessionId, sid);
    assert.deepEqual([...base.free, ...entryIds].sort(), log.map(x => x.id).sort());
    assert.ok(base.openCount + base.doneCount + base.partialCount === base.totalCount, `seed ${seed}`);
  }
});

// A second, simple implementation of the typed, unpinned rule used as an oracle.
function oracle(entries, sessions, look = 6) {
  const taken = new Set();
  const out = {};
  for (const x of [...entries].sort(cmpEntry)) {
    const win = sessions.filter(s => !s.skipped && !taken.has(s.id)).slice(0, look);
    const s = win.find(c => c.runType === x.runType);
    if (s) { taken.add(s.id); out[x.id] = s.id; }
  }
  return out;
}

test('property: dated typed runs follow the earliest-of-type-in-window rule (oracle)', () => {
  for (let seed = 200; seed < 320; seed++) {
    const rand = rng(seed);
    const log = randomLog(rand, { n: 5 + Math.floor(rand() * 30), types: ['easy', 'tempo', 'long', 'shakeout', 'race'] });
    const over = seed % 2 ? { skipped: ['w1-tempo', 'w3-long'], repeatWeeks: [2] } : {};
    const sessions = sessionsOf(over);
    const want = oracle(log, sessions);
    const m = match(log, over);
    const got = Object.fromEntries(Object.entries(m.byEntry).map(([id, v]) => [id, v.sessionId]));
    assert.deepEqual(got, want, `seed ${seed}`);
    for (const id of m.free) assert.equal(want[id], undefined);
  }
});

test('property: deleting a run only changes that run and the runs after it (earlier runs keep their sessions)', () => {
  for (let seed = 400; seed < 500; seed++) {
    const rand = rng(seed);
    const log = randomLog(rand, { n: 8 + Math.floor(rand() * 20) });
    const full = match(log);
    const victim = pick(rand, log);
    const without = match(log.filter(x => x.id !== victim.id));
    for (const x of log) {
      if (x.id === victim.id || cmpEntry(x, victim) >= 0) continue;
      assert.deepEqual(without.byEntry[x.id], full.byEntry[x.id], `seed ${seed}: an earlier run changed`);
    }
    assert.equal(without.byEntry[victim.id], undefined);
    // sessions held by earlier runs are unchanged, so the change is confined to sessions the victim or later runs held / could hold
    for (const x of log) {
      if (cmpEntry(x, victim) < 0 && full.byEntry[x.id]) assert.equal(without.bySession[full.byEntry[x.id].sessionId].entryId, x.id);
    }
  }
});

test('property: editing the km of a typed run only changes that session\'s flag, not any assignment', () => {
  for (let seed = 600; seed < 700; seed++) {
    const rand = rng(seed);
    const log = randomLog(rand, { n: 6 + Math.floor(rand() * 20), types: ['easy', 'tempo', 'long', 'shakeout', 'race'] });
    const target = pick(rand, log);
    const before = match(log);
    const after = match(log.map(x => (x.id === target.id ? { ...x, km: Math.round((1 + rand() * 20) * 10) / 10 } : x)));
    const assign = m => Object.fromEntries(Object.entries(m.byEntry).map(([id, v]) => [id, v.sessionId]));
    assert.deepEqual(assign(after), assign(before), `seed ${seed}`);
    for (const [sid, v] of Object.entries(before.bySession)) {
      if (v.entryId !== target.id) assert.deepEqual(after.bySession[sid], v);
    }
  }
});

test('property: pins always hold their session; free runs are unmatched ones; every session holds at most one run', () => {
  for (let seed = 800; seed < 900; seed++) {
    const rand = rng(seed);
    const log = randomLog(rand, { n: 5 + Math.floor(rand() * 20), pins: true });
    const m = match(log);
    const holders = new Map();
    for (const x of [...log].sort(cmpEntry)) if (x.session && !holders.has(x.session)) holders.set(x.session, x.id);
    for (const [sid, id] of holders) assert.equal(m.bySession[sid].entryId, id, `seed ${seed}`);
    assert.equal(new Set(Object.values(m.bySession).map(v => v.entryId)).size, matchedIds(m).length);
  }
});

test('property: rolling weeks are never missed, matched counts add up, progress only grows with more runs', () => {
  for (let seed = 1000; seed < 1060; seed++) {
    const rand = rng(seed);
    const log = randomLog(rand, { n: 3 + Math.floor(rand() * 30) });
    const today = addDays(START, Math.floor(rand() * 260));
    const weeks = buildWeeksFor({ log, state: { a: { mode: 'rolling', startDate: START }, b: { mode: 'rolling' } }, todayISO: today });
    assert.equal(weeks.length, PLAN.length);
    let currents = 0;
    for (const w of weeks) {
      assert.notEqual(w.a.status, 'missed');
      assert.notEqual(w.b.status, 'missed');
      assert.ok(['fulfilled', 'current', 'upcoming', 'n/a'].includes(w.a.status));
      if (w.a.status === 'current') currents++;
    }
    assert.ok(currents <= 1);
    const idx = weeks.findIndex(w => w.a.status === 'current');
    if (idx >= 0) {
      assert.ok(weeks.slice(0, idx).every(w => w.a.status === 'fulfilled' || w.a.status === 'n/a'), `seed ${seed}: earlier weeks are fulfilled`);
    }
  }
});

/* ---------- pace ---------- */

const due = (over, today, sessions = sessionsOf(over)) => sessionsDue({ sessions, personState: state(over), startDate: over.startDate || START, todayISO: today });
const behind = (over, today, entries = []) => {
  const st = state(over);
  const sessions = buildSessions(PLAN, {}, st, 'a');
  const m = matchRuns({ sessions, entries, personState: st, todayISO: today, startDate: st.startDate });
  return { m, n: behindSessions({ sessions, match: m, personState: st, startDate: st.startDate, todayISO: today }) };
};

test('pace without a race date: the plan\'s own calendar, a week is due once it has completely passed', () => {
  assert.deepEqual(due({}, START), { due: 0, total: 89, basis: 'calendar' });
  assert.equal(due({}, '2026-03-08').due, 0, 'Sunday of week 1: still running');
  assert.equal(due({}, '2026-03-09').due, 3, 'Monday of week 2: week 1 is complete');
  assert.equal(due({}, '2026-03-15').due, 3);
  assert.equal(due({}, '2026-03-16').due, 6);
  assert.equal(due({}, '2026-03-01').due, 0, 'before the start');
  assert.equal(due({}, '2030-01-01').due, 89, 'after the plan: everything is due');
});

test('pace: skipped sessions and optional ones are not due; a repeated week takes one more calendar week', () => {
  assert.equal(due({ skipped: ['w1-tempo'] }, '2026-03-09').due, 2);
  assert.equal(due({ repeatWeeks: [1] }, '2026-03-09').due, 3);
  assert.equal(due({ repeatWeeks: [1] }, '2026-03-16').due, 6, 'the repeat pass of week 1 is due after two weeks');
  assert.equal(due({ repeatWeeks: [1] }, '2026-03-23').due, 9);
  assert.equal(due({ repeatWeeks: [1] }, '2026-03-30').due, 12, 'week 2 follows the repeat pass');
  assert.equal(due({ skipped: ['1-30-1-a'] }, '2030-01-01').total, 89, 'the optional shakeout is not counted either way');
});

test('pace: pauses shift the calendar (paused days do not count as elapsed)', () => {
  const pause = { pauses: [{ from: '2026-03-02', to: '2026-03-08' }] };
  assert.equal(due(pause, '2026-03-09').due, 0, 'the first week was paused');
  assert.equal(due(pause, '2026-03-16').due, 3);
  const mid = { pauses: [{ from: '2026-03-10', to: '2026-03-16' }] };
  assert.equal(due(mid, '2026-03-17').due, 3, 'week 2 would have been done by 3/16, the pause pushes it a week');
  assert.equal(due(mid, '2026-03-23').due, 6);
  assert.equal(due({ pauses: [{ from: '2026-03-02', to: '2026-03-04' }] }, '2026-03-12').due, 3, '3 paused days: 10 - 3 = 7 elapsed days');
  assert.equal(due({ pauses: [{ from: '2026-03-02', to: '2026-03-04' }] }, '2026-03-11').due, 0);
});

test('pace across daylight saving changes counts calendar days, not hours', () => {
  // Europe/Zurich: DST starts 2026-03-29 and ends 2026-10-25
  assert.equal(due({ startDate: '2026-03-23' }, '2026-03-30').due, 3, '7 days across the spring change');
  assert.equal(due({ startDate: '2026-03-23' }, '2026-03-29').due, 0);
  assert.equal(due({ startDate: '2026-10-19' }, '2026-10-26').due, 3, '7 days across the autumn change');
  assert.equal(due({ startDate: '2026-10-19' }, '2026-10-25').due, 0);
  const pause = { startDate: '2026-03-23', pauses: [{ from: '2026-03-28', to: '2026-03-30' }] };
  assert.equal(due(pause, '2026-04-01').due, 0, '9 days minus 3 paused = 6');
  assert.equal(due(pause, '2026-04-02').due, 3, '10 days minus 3 paused = 7');
  const race = { startDate: '2026-03-20', raceDate: '2026-10-30' };
  assert.equal(daysBetween('2026-03-20', '2026-10-30'), 224);
  assert.equal(due(race, '2026-10-30').due, 88);
});

test('pace with a race date: sessions spread evenly over the days up to the race', () => {
  const total = 89;
  const over = { raceDate: addDays(START, total) }; // one session per day
  assert.deepEqual(due(over, START), { due: 0, total, basis: 'race' });
  assert.equal(due(over, addDays(START, 10)).due, 10);
  assert.equal(due(over, addDays(START, 88)).due, 88);
  assert.equal(due(over, addDays(START, total)).due, 88, 'on race day the race itself is not yet due');
  assert.equal(due(over, addDays(START, total + 1)).due, 89, 'after the race everything is due');
  // 2 sessions per 3 days
  const slow = { raceDate: addDays(START, 133) }; // 89 / 133 per day
  assert.equal(due(slow, addDays(START, 30)).due, Math.floor(89 * 30 / 133));
  // a pause shortens the available days and counts as not elapsed
  const paused = { raceDate: addDays(START, total + 10), pauses: [{ from: addDays(START, 5), to: addDays(START, 14) }] };
  assert.equal(due(paused, addDays(START, 40)).due, Math.floor(89 * (40 - 10) / 89));
  assert.equal(due(paused, addDays(START, 10)).due, 5, 'inside the pause: only the days before it count');
  // skipped sessions shrink the total
  assert.equal(due({ ...over, skipped: ['w1-tempo'] }, addDays(START, 88)).total, 88);
  // a race date on or before the start gives no pace: fall back to the plan calendar
  assert.equal(due({ raceDate: START }, '2026-03-09').basis, 'calendar');
  assert.equal(due({ raceDate: '2026-02-01' }, '2026-03-09').due, 3);
});

test('behindSessions: due minus matched, never negative; 0 without a start date', () => {
  assert.equal(behind({}, '2026-03-09').n, 3);
  assert.equal(behind({}, '2026-03-09', perfect(2)).n, 1);
  assert.equal(behind({}, '2026-03-09', perfect(3)).n, 0);
  assert.equal(behind({}, '2026-03-09', perfect(10)).n, 0, 'ahead of pace is not negative');
  assert.equal(behind({}, '2026-03-09', [e('2026-03-03', 'easy', 1)]).n, 2, 'a partial run consumes its session for the pace');
  assert.equal(behind({ raceDate: '2026-12-01' }, '2026-03-09').n, Math.floor(89 * 7 / 274));
  assert.equal(behind({ pauses: [{ from: START, to: '2026-03-08' }] }, '2026-03-09').n, 0);
  // no start date derivable from the arguments: 0
  const st = normalizePersonState({ mode: 'rolling' });
  const sessions = buildSessions(PLAN, {}, st, 'a');
  assert.equal(matchRuns({ sessions, entries: [], personState: st, todayISO: '2030-01-01' }).behind, 0);
  assert.equal(matchRuns({ sessions, entries: [] }).behind, 0);
  // matchRuns computes it when a start date is known (argument or state fallback)
  assert.equal(matchRuns({ sessions, entries: [], personState: st, todayISO: '2026-03-09', startDate: START }).behind, 3);
  const fb = normalizePersonState({ mode: 'rolling' }, { settingsStartDate: START });
  assert.equal(matchRuns({ sessions, entries: [], personState: fb, todayISO: '2026-03-09' }).behind, 3);
});

test('property: with nothing logged, behind never decreases as days pass; with or without race date and pauses', () => {
  for (let seed = 2000; seed < 2040; seed++) {
    const rand = rng(seed);
    const over = {};
    if (seed % 2) over.raceDate = addDays(START, 60 + Math.floor(rand() * 200));
    if (seed % 3 === 0) over.pauses = [{ from: addDays(START, 10 + Math.floor(rand() * 20)), to: addDays(START, 35 + Math.floor(rand() * 20)) }];
    let last = 0;
    for (let d = -3; d < 300; d += 1 + Math.floor(rand() * 4)) {
      const n = behind(over, addDays(START, d)).n;
      assert.ok(n >= last && n >= 0 && n <= 89, `seed ${seed} day ${d}`);
      last = n;
    }
  }
});

/* ---------- race feasibility ---------- */

test('raceFeasibility: sessions left vs training days left', () => {
  const st = state({ raceDate: '2026-04-05' }); // 5 weeks
  const sessions = buildSessions(PLAN, {}, st, 'a');
  const m = matchRuns({ sessions, entries: [], personState: st, todayISO: '2026-03-02', startDate: START });
  const f = raceFeasibility({ sessions, match: m, personState: st, todayISO: '2026-03-02' });
  assert.equal(f.daysLeft, 34);
  assert.equal(f.sessionsLeft, 89);
  assert.equal(f.fits, false);
  assert.equal(f.shortBy, f.sessionsLeft - f.slots);
  assert.equal(f.slots, Math.floor(34 * 3 / 7) + 1, 'default 3 a week plus the race day');
  assert.equal(raceFeasibility({ sessions, match: m, personState: state(), todayISO: '2026-03-02' }), null, 'no race date, no feasibility');
});

test('raceFeasibility: uses training days, pauses, ran today, and the race date itself', () => {
  const sessions = sessionsOf();
  const only = (over, today, entries = perfect(86), ranToday = false) => {
    const st = state(over);
    const m = matchRuns({ sessions, entries, personState: st, todayISO: today, startDate: START });
    return raceFeasibility({ sessions, match: m, personState: st, todayISO: today, ranToday });
  };
  // 3 sessions left (week 30: easy + race, plus one more), race in 2 weeks
  const base = { raceDate: '2026-10-04' };
  const a = only({ ...base, trainingDays: [2, 4, 6] }, '2026-09-21');
  assert.equal(a.sessionsLeft, 3);
  assert.deepEqual([a.daysLeft, a.fits, a.shortBy], [13, true, 0]);
  // Tue 22 Thu 24 Sat 26 Tue 29 Thu 1 Sat 3 = 6 + race day Sunday 4
  assert.equal(a.slots, 7);
  assert.equal(only({ ...base, trainingDays: [2] }, '2026-09-21').slots, 3, 'Tuesdays 22, 29 and the race day');
  assert.equal(only({ ...base, trainingDays: [2] }, '2026-09-22', undefined, true).slots, 2, 'ran today: today is not a slot');
  const paused = only({ ...base, trainingDays: [2, 4, 6], pauses: [{ from: '2026-09-21', to: '2026-10-02' }] }, '2026-09-21');
  assert.equal(paused.slots, 2, 'only Sat 3 and the race day are left');
  assert.equal(paused.fits, false);
  assert.equal(paused.shortBy, 1);
  // race passed
  const over = only({ raceDate: '2026-09-01' }, '2026-09-21');
  assert.deepEqual([over.daysLeft, over.slots, over.fits], [0, 0, false]);
  // race day itself: one slot
  assert.equal(only({ raceDate: '2026-09-21' }, '2026-09-21').slots, 1);
});

/* ---------- rolling week view (buildWeeksFor) ---------- */

const weeksOf = (log, today, a = {}, extra = {}) => buildWeeksFor({ log, state: { a: { mode: 'rolling', startDate: START, ...a }, ...extra }, todayISO: today });

test('rolling weeks: same shape as buildWeeks, derived from the matched sessions', () => {
  const log = [e('2026-03-02', 'easy', 5), e('2026-03-03', 'tempo', 5), e('2026-03-05', 'long', 7), e('2026-03-20', 'easy', 5)];
  const w = weeksOf(log, '2026-03-30');
  assert.equal(w.length, PLAN.length);
  const w1 = w[0].a;
  assert.deepEqual(Object.keys(w1).slice(0, 6), ['plannedKm', 'doneKm', 'pct', 'status', 'runs', 'entries']);
  assert.equal(w1.plannedKm, 16.5);
  assert.equal(w1.doneKm, 17);
  assert.equal(w1.pct, 100);
  assert.equal(w1.status, 'fulfilled');
  assert.equal(w1.entries.length, 3);
  assert.deepEqual(w1.runs.map(r => r.id), ['1-1-0-a', '1-1-1-a', '1-1-2-a']);
  assert.deepEqual(Object.keys(w1.runs[0]).slice(0, 7), ['id', 'runId', 'type', 'runType', 'detail', 'mult', 'km']);
  assert.equal(w1.runs[0].defaultKm, 5);
  assert.equal(w1.runs[0].matched.entryId, log[0].id);
  // the easy run on 20 March took week 2's easy session, so week 2 is the current one though the calendar is in week 5
  assert.equal(w[1].a.status, 'current');
  assert.equal(w[1].a.doneKm, 5);
  assert.equal(w[1].a.pct, 30);
  assert.equal(w[1].a.sessionsDone, 1);
  assert.equal(w[1].a.sessionsTotal, 3);
  assert.equal(w[2].a.status, 'upcoming');
  assert.equal(w[2].a.pct, 0);
  assert.equal(w[0].current, false);
  assert.equal(w[1].current, true, 'the viewer\'s current week follows the queue');
  assert.equal(w[4].current, false);
  // person b is not rolling: calendar rules, calendar current week
  assert.equal(w[0].b.status, 'missed');
  assert.equal(w[4].b.status, 'current');
});

test('rolling weeks: nothing is ever missed, a person far behind simply sits in an early week', () => {
  const w = weeksOf([], '2027-01-01');
  assert.equal(w[0].a.status, 'current');
  assert.ok(w.slice(1).every(x => x.a.status === 'upcoming'));
  assert.equal(w[0].a.behindSessions, 89);
  assert.ok(w.every(x => x.a.behindSessions === 89));
  assert.equal(weeksOf([], '2027-01-01', {}).filter(x => x.a.status === 'missed').length, 0);
  // the whole plan done: every week fulfilled, no current
  const all = weeksOf(perfect(90), '2026-09-27');
  assert.ok(all.every(x => x.a.status === 'fulfilled'));
  assert.equal(all.filter(x => x.current).length, 0);
  assert.equal(all[29].a.pct, 100);
  assert.equal(all[29].a.entries.length, 3);
  const noShake = weeksOf(perfect(90).filter(x => x.runType !== 'shakeout'), '2026-09-27');
  assert.equal(noShake[29].a.status, 'fulfilled', 'the optional shakeout is not needed');
});

test('rolling weeks: skipped sessions leave plannedKm, repeats add to the week and a week with everything skipped is n/a', () => {
  const w = weeksOf([e('2026-03-02', 'easy', 5), e('2026-03-04', 'long', 6.5)], '2026-03-06', { skipped: ['w1-tempo'] });
  assert.equal(w[0].a.plannedKm, 11.5);
  assert.equal(w[0].a.status, 'fulfilled');
  assert.equal(w[0].a.runs.find(r => r.runType === 'tempo').skipped, true);
  assert.equal(w[0].a.runs.length, 3);
  const rep = weeksOf(perfect(3), '2026-03-12', { repeatWeeks: [1] });
  assert.equal(rep[0].a.plannedKm, 33);
  assert.equal(rep[0].a.status, 'current', 'the repeat pass is still open');
  assert.equal(rep[0].a.repeated, true);
  assert.equal(rep[0].a.runs.length, 6);
  assert.equal(rep[0].a.runs[3].id, '1-1-0-a~r2');
  assert.equal(rep[0].a.runs[3].repeat, true);
  assert.equal(rep[0].a.pct, 50);
  assert.equal(rep[1].a.status, 'upcoming');
  const skipAll = weeksOf([], '2026-03-06', { skipped: ['w1-easy', 'w1-tempo', 'w1-long'] });
  assert.equal(skipAll[0].a.status, 'n/a');
  assert.equal(skipAll[0].a.pct, null);
  assert.equal(skipAll[1].a.status, 'current');
});

test('rolling weeks: partial runs fulfil the week status but not the percentage', () => {
  const w = weeksOf([e('2026-03-02', 'easy', 5), e('2026-03-03', 'tempo', 5), e('2026-03-05', 'long', 3)], '2026-03-06');
  assert.equal(w[0].a.status, 'fulfilled');
  assert.equal(w[0].a.partialCount, 1);
  assert.equal(w[0].a.pct, 79);
});

test('rolling weeks: undated imports with a week override fill that week', () => {
  const w = weeksOf([e(null, 'easy', 5, { week: 1 }), e(null, 'tempo', 5, { week: 1 }), e(null, 'long', 6.5, { week: 1 })], '2026-06-01');
  assert.equal(w[0].a.status, 'fulfilled');
  assert.equal(w[0].a.doneKm, 16.5);
  assert.equal(w[1].a.status, 'current');
});

test('rolling and calendar people are independent; a calendar state is byte-for-byte the old output', () => {
  const log = [e('2026-03-02', 'easy', 5), e('2026-03-04', 'easy', 5, { person: 'b' })];
  const plain = buildWeeksFor({ log, state: { a: { startDate: START }, b: { startDate: START } }, todayISO: '2026-03-20' });
  const explicit = buildWeeksFor({ log, state: { a: { mode: 'calendar', startDate: START, repeatWeeks: [3], skipped: ['w1-easy'] }, b: { startDate: START } }, todayISO: '2026-03-20' });
  assert.deepEqual(explicit, plain, 'repeatWeeks / skipped do nothing in calendar mode');
  const mixed = buildWeeksFor({ log, state: { a: { mode: 'rolling', startDate: START }, b: { startDate: START } }, todayISO: '2026-03-20' });
  assert.deepEqual(mixed.map(w => w.b), plain.map(w => w.b));
  assert.notDeepEqual(mixed.map(w => w.a), plain.map(w => w.a));
  const asB = buildWeeksFor({ log, state: { a: { mode: 'rolling', startDate: START }, b: { startDate: START } }, todayISO: '2026-03-20', viewer: 'b' });
  assert.deepEqual(asB.map(w => w.current), plain.map(w => w.current), 'a calendar viewer keeps the calendar current week');
});

test('weekStreak stays calendar based in rolling mode and respects pauses', () => {
  const log = [e('2026-03-02', 'easy', 5), e('2026-03-04', 'tempo', 5), e('2026-03-06', 'long', 6.5)];
  const roll = weekStreak({ log, person: 'a', state: normalizePlanState({ a: { mode: 'rolling', startDate: START } }), todayISO: '2026-03-08' });
  assert.equal(roll.current, 1);
  const paused = weekStreak({ log, person: 'a', state: normalizePlanState({ a: { mode: 'rolling', startDate: START, pauses: [{ from: '2026-03-09', to: '2026-03-15' }] } }), todayISO: '2026-03-18' });
  assert.equal(paused.current, 1, 'a fully paused week is skipped, neither counts nor breaks');
});

/* ---------- suggestSession / explainMatch ---------- */

test('suggestSession: what a new run would count for', () => {
  const st = state();
  const sessions = buildSessions(PLAN, {}, st, 'a');
  const entries = [e('2026-03-02', 'easy', 5), e('2026-03-03', 'tempo', 5)];
  const m = matchRuns({ sessions, entries, personState: st, todayISO: '2026-03-05' });
  assert.deepEqual(suggestSession({ person: 'a', draft: { runType: 'long', km: 7, date: '2026-03-05' }, sessions, match: m }),
    { sessionId: '1-1-2-a', week: 1, label: 'Long run · Week 1' });
  assert.equal(suggestSession({ person: 'a', draft: { runType: 'easy', km: 5, date: '2026-03-05' }, sessions, match: m }).label, 'Easy · Week 2');
  assert.equal(suggestSession({ person: 'a', draft: { runType: 'race', km: 21, date: '2026-03-05' }, sessions, match: m }), null);
  assert.equal(suggestSession({ person: 'a', draft: { km: 6.6, date: '2026-03-05' }, sessions, match: m }).sessionId, '1-1-2-a', 'no run type: closest km');
  // exact path with the entries: a draft dated before existing runs takes precedence
  const early = suggestSession({ person: 'a', draft: { runType: 'easy', km: 5, date: '2026-03-01' }, sessions, match: m, entries, personState: st });
  assert.equal(early.sessionId, '1-1-0-a');
  // suggestion == actual matching after saving the run
  const after = matchRuns({ sessions, entries: [...entries, e('2026-03-05', 'long', 7, { id: 'new' })], personState: st, todayISO: '2026-03-05' });
  assert.equal(after.byEntry.new.sessionId, suggestSession({ person: 'a', draft: { runType: 'long', km: 7, date: '2026-03-05' }, sessions, match: m, entries, personState: st }).sessionId);
});

test('suggestSession: edits, pins and skipped sessions', () => {
  const st = state({ skipped: ['w1-long'] });
  const sessions = buildSessions(PLAN, {}, st, 'a');
  const entries = [e('2026-03-02', 'easy', 5, { id: 'mine' })];
  const m = matchRuns({ sessions, entries, personState: st, todayISO: '2026-03-05' });
  const same = suggestSession({ person: 'a', draft: { id: 'mine', runType: 'easy', km: 5.5, date: '2026-03-02' }, sessions, match: m, entries, personState: st });
  assert.deepEqual(same, { sessionId: '1-1-0-a', week: 1, label: 'Easy · Week 1', alreadyMatched: true });
  const moved = suggestSession({ person: 'a', draft: { id: 'mine', runType: 'tempo', km: 5, date: '2026-03-02' }, sessions, match: m, entries, personState: st });
  assert.equal(moved.sessionId, '1-1-1-a');
  assert.equal(moved.alreadyMatched, undefined);
  assert.equal(suggestSession({ person: 'a', draft: { runType: 'long', km: 7, date: '2026-03-05' }, sessions, match: m, entries, personState: st }).sessionId, '1-2-2-a', 'the skipped long run is not a candidate');
  const pin = suggestSession({ person: 'a', draft: { runType: 'long', km: 7, session: '1-1-0-a' }, sessions, match: m });
  assert.deepEqual(pin, { sessionId: '1-1-0-a', week: 1, label: 'Easy · Week 1', alreadyMatched: true }, 'that session is held by another run');
  assert.equal(suggestSession({ person: 'a', draft: { runType: 'long', km: 7, session: '1-1-2-a' }, sessions, match: m }), null, 'a skipped session cannot be pinned');
  assert.equal(suggestSession({ person: 'a', draft: { runType: 'long', km: 7, session: '1-4-1-a' }, sessions, match: m }).alreadyMatched, undefined);
  assert.equal(suggestSession({ person: 'a', draft: { runType: 'easy' }, sessions, match: m }).sessionId, '1-2-0-a', 'works with an empty distance');
  assert.equal(suggestSession({}), null);
});

test('explainMatch labels cards', () => {
  const st = state();
  const sessions = buildSessions(PLAN, {}, st, 'a');
  const m = matchRuns({ sessions, entries: [e('2026-03-02', 'tempo', 5, { id: 'x' }), e('2026-03-03', 'tempo', 2, { id: 'y' }), e('2026-03-04', 'race', 5, { id: 'z' })], personState: st, todayISO: '2026-03-05' });
  assert.equal(explainMatch('x', m, sessions), 'Counts for Tempo, Week 1');
  assert.equal(explainMatch('y', m, sessions), 'Counts for Tempo, Week 2 (partly)');
  assert.equal(explainMatch('z', m, sessions), 'Free run');
  assert.equal(explainMatch('nope', m, sessions), 'Free run');
  assert.equal(explainMatch('x', null, sessions), 'Free run');
  const rep = buildSessions(PLAN, {}, state({ repeatWeeks: [1] }), 'a');
  const m2 = matchRuns({ sessions: rep, entries: [e('2026-03-02', 'tempo', 5, { id: 'p', session: '1-1-1-a~r2' })], personState: state({ repeatWeeks: [1] }), todayISO: '2026-03-05' });
  assert.equal(explainMatch('p', m2, rep), 'Counts for Tempo, Week 1 (repeat)');
});

/* ---------- plan operations ---------- */

test('skip / unskip patches: validated, idempotent, never mutate', () => {
  const st = state({ skipped: ['w3-tempo'] });
  const frozen = JSON.stringify(st);
  assert.deepEqual(skipSessionPatch(st, '1-7-1-a'), { skipped: ['w3-tempo', '1-7-1-a'] });
  assert.deepEqual(skipSessionPatch(st, 'w3-tempo'), { skipped: ['w3-tempo'] });
  assert.deepEqual(skipSessionPatch(st, ' 1-7-1-a '), { skipped: ['w3-tempo', '1-7-1-a'] });
  assert.deepEqual(unskipSessionPatch(st, 'w3-tempo'), { skipped: [] });
  assert.deepEqual(unskipSessionPatch(st, '1-3-1-a'), { skipped: [] }, 'the run id also removes its alias');
  assert.deepEqual(unskipSessionPatch(st, '1-9-1-a'), { skipped: ['w3-tempo'] });
  assert.deepEqual(unskipSessionPatch(state({ skipped: ['1-3-1-a~r2', 'w3-tempo~r2', 'w3-tempo'] }), '1-3-1-a~r2'), { skipped: ['w3-tempo'] });
  assert.deepEqual(skipSessionPatch(undefined, '1-1-0-a'), { skipped: ['1-1-0-a'] });
  assert.equal(JSON.stringify(st), frozen);
  assert.throws(() => skipSessionPatch(st, ''), /skip/);
  assert.throws(() => skipSessionPatch(st, 5), /skip/);
  assert.throws(() => unskipSessionPatch(st, null), /restore/);
  // the patch goes through validatePlanPatch, so a setPlanState call accepts it
  assert.equal(validatePlanPatch(skipSessionPatch(st, '1-7-1-a')).ok, true);
});

test('repeat / unrepeat patches', () => {
  const st = state({ repeatWeeks: [4] });
  assert.deepEqual(repeatWeekPatch(st, 2), { repeatWeeks: [2, 4] });
  assert.deepEqual(repeatWeekPatch(st, 4), { repeatWeeks: [4] });
  assert.deepEqual(repeatWeekPatch(st, '7'), { repeatWeeks: [4, 7] });
  assert.deepEqual(unrepeatWeekPatch(st, 4), { repeatWeeks: [] });
  assert.deepEqual(unrepeatWeekPatch(st, 9), { repeatWeeks: [4] });
  for (const bad of [0, 31, 1.5, 'x', null]) assert.throws(() => repeatWeekPatch(st, bad), /plan week/);
  assert.deepEqual(st.repeatWeeks, [4]);
});

test('pause patches merge, sort, validate and never mutate', () => {
  const st = state({ pauses: [{ from: '2026-04-01', to: '2026-04-07', note: 'holiday' }] });
  const frozen = JSON.stringify(st);
  assert.deepEqual(addPausePatch(st, { from: '2026-03-10', to: '2026-03-12', note: ' flu ' }),
    { pauses: [{ from: '2026-03-10', to: '2026-03-12', note: 'flu' }, { from: '2026-04-01', to: '2026-04-07', note: 'holiday' }] });
  assert.deepEqual(addPausePatch(st, { from: '2026-04-05', to: '2026-04-10' }).pauses, [{ from: '2026-04-01', to: '2026-04-10', note: 'holiday' }]);
  assert.deepEqual(removePausePatch(st, 0), { pauses: [] });
  assert.throws(() => addPausePatch(st, { from: '2026-04-05', to: '2026-04-01' }), /pause/i);
  assert.throws(() => addPausePatch(st, { from: 'x', to: '2026-04-01' }), /pause/i);
  assert.throws(() => addPausePatch(st, null), /pause/i);
  assert.throws(() => removePausePatch(st, 3), /no longer exists/);
  assert.throws(() => removePausePatch(st, -1), /no longer exists/);
  assert.throws(() => removePausePatch(st, 0.5), /no longer exists/);
  assert.equal(JSON.stringify(st), frozen);
});

test('previewModeSwitch: what the switch changes', () => {
  // start 2026-03-02, today 2026-03-30 (week 5): the person did week 1 only
  const log = perfect(3);
  const p = previewModeSwitch({ log, state: { startDate: START }, todayISO: '2026-03-30', person: 'a' });
  assert.deepEqual(p.calendar, { currentWeek: 5, fulfilledWeeks: 1, behind: 3 });
  assert.equal(p.rolling.currentWeek, 2);
  assert.equal(p.rolling.fulfilledWeeks, 1);
  assert.equal(p.rolling.nextSession.id, '1-2-0-a');
  // the state mode does not matter: both scenarios are always computed
  const q = previewModeSwitch({ log, state: { a: { mode: 'rolling', startDate: START } }, todayISO: '2026-03-30', person: 'a' });
  assert.deepEqual(q, p);
  // everything done
  const done = previewModeSwitch({ log: perfect(90), state: { startDate: START }, todayISO: '2026-12-30' });
  assert.equal(done.rolling.nextSession, null);
  assert.equal(done.rolling.currentWeek, null);
  assert.equal(done.rolling.fulfilledWeeks, 30);
  // never throws on an empty call
  assert.doesNotThrow(() => previewModeSwitch({ todayISO: '2026-03-30' }));
});

test('rollingStateFor and nextOpenSession', () => {
  const v = rollingStateFor({ log: perfect(4), person: 'a', state: { startDate: START }, todayISO: '2026-03-20' });
  assert.equal(v.sessions.length, 90);
  assert.equal(nextOpenSession(v.sessions, v.match).id, '1-2-1-a');
  assert.equal(nextOpenSession(v.sessions, { firstOpenIndex: -1 }), null);
  assert.equal(nextOpenSession([], null), null);
  const w = rollingWeeksFor({ plan: PLAN, goals: {}, log: perfect(4), person: 'a', state: { startDate: START }, todayISO: '2026-03-20' });
  assert.equal(w.currentIndex, 1);
  assert.equal(w.nextSession.id, '1-2-1-a');
  assert.equal(w.weeks.length, 30);
});
