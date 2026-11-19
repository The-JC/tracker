// The plan-model layer: per-person plan state (start, race date, pauses, ...), the week mapping that follows from it,
// and the week streak. Pure: no Vue, no Firebase, no DOM, no clock (today is always passed in), so the app, the Cloudflare
// Worker bundle and node tests all import this one file (docs/FLEXIBLE_PLAN.md §8 is the API reference).
//
// Design rules
//  * scoring.js `buildWeeks` stays the single-start reference implementation. `buildWeeksFor` composes it once per person
//    (each with THEIR OWN start date) and merges the results, so there is no second copy of the week logic.
//  * Normalisation never throws: unknown / invalid fields are dropped and replaced by the defaults.
//  * Dates are local calendar dates 'YYYY-MM-DD'; all arithmetic goes through scoring.js (UTC based, DST safe).
import { PLAN } from './plan.js';
import {
  buildWeeks, effectiveStartDate, weekOfEntry, weekForDate, goalKm, addDays, daysBetween, mondayOf, isValidISODate, todayISO as nowISO
} from './scoring.js';

export const PERSONS = ['a', 'b'];
export const PLAN_MODES = ['calendar', 'rolling'];

// Limits (the database is only ever written through validatePlanPatch / normalizePersonState).
export const MAX_PAUSES = 50;
export const MAX_SKIPPED = 300;
export const MAX_NOTE = 80;
export const MAX_WEEKLY_TARGET = 14;
const MAX_ID = 60;

// Plan state of one person that has never touched the controls. `fallbackStartDate` is not stored in the database: it is the
// legacy global settings/startDate, filled in by normalizePlanState({ settingsStartDate }) and used when `startDate` is null.
export const DEFAULT_PLAN_STATE = Object.freeze({
  mode: 'calendar',
  startDate: null,
  raceDate: null,
  pauses: Object.freeze([]),
  skipped: Object.freeze([]),
  trainingDays: Object.freeze([]),
  weeklyTarget: null,
  fallbackStartDate: null
});

/* ---------- normalisation ---------- */

const validIso = v => (typeof v === 'string' && isValidISODate(v) ? v : null);
// Firebase hands arrays back as objects when they have holes; accept both.
const toList = v => (Array.isArray(v) ? v : v && typeof v === 'object' ? Object.values(v) : []);
const isPlainObject = v => !!v && typeof v === 'object' && !Array.isArray(v);

function cleanNote(v) {
  return typeof v === 'string' ? v.replace(/\s+/g, ' ').trim().slice(0, MAX_NOTE) : '';
}

// [{ from, to, note? }] -> valid ranges (from <= to), sorted by from, overlapping ranges merged (adjacent ones stay separate).
export function normalizePauses(raw) {
  const list = [];
  for (const p of toList(raw).slice(0, MAX_PAUSES * 2)) {
    if (!isPlainObject(p)) continue;
    const from = validIso(p.from), to = validIso(p.to);
    if (!from || !to || to < from) continue;
    const note = cleanNote(p.note);
    list.push(note ? { from, to, note } : { from, to });
  }
  list.sort((x, y) => (x.from < y.from ? -1 : x.from > y.from ? 1 : x.to < y.to ? -1 : x.to > y.to ? 1 : 0));
  const merged = [];
  for (const p of list) {
    const last = merged[merged.length - 1];
    if (last && p.from <= last.to) {
      if (p.to > last.to) last.to = p.to;
      if (!last.note && p.note) last.note = p.note;
    } else merged.push({ ...p });
  }
  return merged.slice(0, MAX_PAUSES);
}

// Strings (session ids like 'w7-speed'), trimmed, deduplicated, original order.
export function normalizeSkipped(raw) {
  const seen = new Set();
  const out = [];
  for (const v of toList(raw)) {
    if (typeof v !== 'string') continue;
    const s = v.trim();
    if (!s || s.length > MAX_ID || seen.has(s)) continue;
    seen.add(s);
    out.push(s);
    if (out.length >= MAX_SKIPPED) break;
  }
  return out;
}

const asWeekday = v => {
  const n = typeof v === 'number' ? v : typeof v === 'string' && /^[0-6]$/.test(v.trim()) ? Number(v) : NaN;
  return Number.isInteger(n) && n >= 0 && n <= 6 ? n : null;
};

// Weekdays 0 = Sunday ... 6 = Saturday: integers only, deduplicated, ascending.
export function normalizeTrainingDays(raw) {
  const set = new Set();
  for (const v of toList(raw)) { const d = asWeekday(v); if (d !== null) set.add(d); }
  return [...set].sort((x, y) => x - y);
}

const asWeeklyTarget = v => {
  const n = typeof v === 'number' ? v : typeof v === 'string' && v.trim() !== '' ? Number(v) : NaN;
  return Number.isInteger(n) && n >= 1 && n <= MAX_WEEKLY_TARGET ? n : null;
};

// One person's stored node -> a complete, valid state. Never throws. `settingsStartDate` (legacy settings/startDate) becomes
// `fallbackStartDate`; `startDate` itself only ever holds the person's own explicit start.
export function normalizePersonState(raw, { settingsStartDate = null } = {}) {
  const r = isPlainObject(raw) ? raw : {};
  return {
    mode: r.mode === 'rolling' ? 'rolling' : 'calendar',
    startDate: validIso(r.startDate),
    raceDate: validIso(r.raceDate),
    pauses: normalizePauses(r.pauses),
    skipped: normalizeSkipped(r.skipped),
    trainingDays: normalizeTrainingDays(r.trainingDays),
    weeklyTarget: asWeeklyTarget(r.weeklyTarget),
    fallbackStartDate: validIso(settingsStartDate)
  };
}

// The `plans` node ({ a, b }) -> { a: PlanState, b: PlanState }. Idempotent for its own output.
export function normalizePlanState(raw, { settingsStartDate = null } = {}) {
  const r = isPlainObject(raw) ? raw : {};
  return {
    a: normalizePersonState(r.a, { settingsStartDate }),
    b: normalizePersonState(r.b, { settingsStartDate })
  };
}

// Accepts the { a, b } states OR one person's state (and raw stored nodes); always returns a normalised person state.
function stateOf(state, person) {
  if (!isPlainObject(state)) return normalizePersonState(null);
  if ('a' in state || 'b' in state) {
    const s = person === 'a' || person === 'b' ? state[person] : null;
    return normalizePersonState(s, { settingsStartDate: isPlainObject(s) ? s.fallbackStartDate : null });
  }
  return normalizePersonState(state, { settingsStartDate: state.fallbackStartDate });
}

/* ---------- validating a patch (setPlanState) ---------- */

export const PLAN_FIELDS = ['mode', 'startDate', 'raceDate', 'pauses', 'skipped', 'trainingDays', 'weeklyTarget'];

// Strict counterpart of normalizePersonState for user input: only the provided fields are checked and an invalid one is an
// error (so the UI can say why), instead of being dropped silently. `null` clears a field (arrays: empty list).
// -> { ok: true, patch } with every value normalised | { ok: false, error }
export function validatePlanPatch(patch) {
  const fail = error => ({ ok: false, error });
  if (!isPlainObject(patch)) return fail('Nothing to change.');
  const out = {};
  for (const key of PLAN_FIELDS) {
    if (!(key in patch) || patch[key] === undefined) continue;
    const v = patch[key];
    if (key === 'mode') {
      if (!PLAN_MODES.includes(v)) return fail('Unknown plan mode.');
      out.mode = v;
    } else if (key === 'startDate' || key === 'raceDate') {
      if (v === null || v === '') out[key] = null;
      else if (typeof v === 'string' && isValidISODate(v)) out[key] = v;
      else return fail(key === 'startDate' ? 'Invalid start date.' : 'Invalid race date.');
    } else if (key === 'pauses') {
      if (v === null) { out.pauses = []; continue; }
      const list = toList(v);
      if (!Array.isArray(v) || list.some(p => !isPlainObject(p) || !validIso(p.from) || !validIso(p.to) || p.to < p.from)) {
        return fail('Each pause needs a valid from and to date, from first.');
      }
      if (list.length > MAX_PAUSES) return fail(`At most ${MAX_PAUSES} pauses.`);
      out.pauses = normalizePauses(list);
    } else if (key === 'skipped') {
      if (v === null) { out.skipped = []; continue; }
      if (!Array.isArray(v) || v.some(s => typeof s !== 'string' || !s.trim() || s.trim().length > MAX_ID)) return fail('Skipped sessions must be a list of ids.');
      out.skipped = normalizeSkipped(v);
    } else if (key === 'trainingDays') {
      if (v === null) { out.trainingDays = []; continue; }
      if (!Array.isArray(v) || v.some(d => asWeekday(d) === null)) return fail('Training days must be weekdays 0 (Sunday) to 6 (Saturday).');
      out.trainingDays = normalizeTrainingDays(v);
    } else if (key === 'weeklyTarget') {
      if (v === null || v === '') out.weeklyTarget = null;
      else if (asWeeklyTarget(v) !== null) out.weeklyTarget = asWeeklyTarget(v);
      else return fail(`The weekly target must be a whole number from 1 to ${MAX_WEEKLY_TARGET}.`);
    }
  }
  return { ok: true, patch: out };
}

/* ---------- start date, week mapping ---------- */

// Start of `person`'s plan: their own startDate, else the legacy global settings/startDate (fallbackStartDate), else the
// automatic rule of scoring.effectiveStartDate (Monday of the earliest dated run's week over the whole log, else this week's Monday).
export function effectiveStartFor(person, state, log, todayISO = nowISO()) {
  const s = stateOf(state, person);
  if (s.startDate) return s.startDate;
  return effectiveStartDate(s.fallbackStartDate, log, todayISO);
}

// Plan week of an entry under `person`'s start; an explicit entry.week override wins exactly like scoring.weekOfEntry.
export function weekOfEntryFor(person, entry, state, log, todayISO = nowISO()) {
  return weekOfEntry(entry, effectiveStartFor(person, state, log, todayISO));
}

// The same output as scoring.buildWeeks, but `a` is evaluated against a's own start and `b` against b's own start.
// The top-level fields (n, kind, tag, current, startDate, endDate) follow `viewer` ('a' by default); use weekWindowsFor for
// both people's dates. With identical starts the result is deep-equal to buildWeeks(plan, goals, log, start, today).
export function buildWeeksFor({ plan = PLAN, goals = {}, log = [], state, todayISO = nowISO(), viewer = 'a' } = {}) {
  const startA = effectiveStartFor('a', state, log, todayISO);
  const startB = effectiveStartFor('b', state, log, todayISO);
  const wa = buildWeeks(plan, goals, log, startA, todayISO);
  const wb = startB === startA ? wa : buildWeeks(plan, goals, log, startB, todayISO);
  const ref = viewer === 'b' ? wb : wa;
  return ref.map((w, i) => ({ ...w, a: wa[i].a, b: wb[i].b }));
}

// Per-person calendar of the plan weeks: { a: [{ n, startDate, endDate, current, over }], b: [...] } in plan order.
export function weekWindowsFor({ plan = PLAN, log = [], state, todayISO = nowISO() } = {}) {
  const out = {};
  for (const p of PERSONS) {
    const start = effectiveStartFor(p, state, log, todayISO);
    out[p] = plan.map(w => {
      const startDate = addDays(start, (w.n - 1) * 7);
      const endDate = addDays(startDate, 6);
      return { n: w.n, startDate, endDate, current: todayISO >= startDate && todayISO <= endDate, over: todayISO > endDate };
    });
  }
  return out;
}

// Index in `windows[person]` of the plan week that contains today (the entry with `current`), or null.
export function currentWeekIndexFor(windows, person) {
  const list = windows && windows[person];
  if (!Array.isArray(list)) return null;
  const i = list.findIndex(w => w.current);
  return i < 0 ? null : i;
}

/* ---------- pauses ---------- */

// Is `dateISO` inside a pause range of this state? (state: one person's state, or { a, b } together with `person`.)
export function isPaused(state, dateISO, person) {
  if (!isValidISODate(dateISO)) return false;
  return stateOf(state, person).pauses.some(p => dateISO >= p.from && dateISO <= p.to);
}

// Number of days (0..7) of the Monday-based week starting `mondayISO` that lie inside pauses.
export function pausedDaysInWeek(state, mondayISO, person) {
  return pausedDaysOf(stateOf(state, person).pauses, mondayISO);
}

function pausedDaysOf(pauses, mondayISO) {
  if (!isValidISODate(mondayISO)) return 0;
  const monday = mondayOf(mondayISO);
  const sunday = addDays(monday, 6);
  let n = 0;
  for (const p of pauses) { // merged ranges never overlap, so the overlaps just add up
    const from = p.from > monday ? p.from : monday;
    const to = p.to < sunday ? p.to : sunday;
    if (to >= from) n += daysBetween(from, to) + 1;
  }
  return n;
}

// A week counts as paused when every one of its seven days is inside a pause (one range, or several back to back).
export function weekIsPaused(state, mondayISO, person) {
  return pausedDaysInWeek(state, mondayISO, person) === 7;
}

/* ---------- plan template ---------- */

// Phase 1: the template is the PLAN constant in code. `id` is reserved for database-seeded templates (phase 5);
// every id returns the default one for now.
export function getPlanTemplate(id = 'default') { // eslint-disable-line no-unused-vars
  return PLAN;
}

/* ---------- weekly target and week streak ---------- */

// Runs with a distance goal per plan week, as the most common value over the weeks (ties: the larger); 3 without a plan.
export function defaultWeeklyTarget(plan = PLAN, person) {
  const counts = new Map();
  for (const w of plan || []) {
    const people = person === 'a' || person === 'b' ? [person] : PERSONS;
    for (const p of people) {
      const n = ((w.runs && w.runs[p]) || []).filter(r => r.km > 0).length;
      counts.set(n, (counts.get(n) || 0) + 1);
    }
  }
  let best = 3, bestCount = 0;
  for (const [n, c] of counts) if (n > 0 && (c > bestCount || (c === bestCount && n > best))) { best = n; bestCount = c; }
  return best;
}

// The weekly run target of a person: their own weeklyTarget, else the plan default.
export function weeklyTargetFor(person, state, plan = PLAN) {
  const s = stateOf(state, person);
  return s.weeklyTarget != null ? s.weeklyTarget : defaultWeeklyTarget(plan, person);
}

// Week streak (docs/FLEXIBLE_PLAN.md §7). A calendar week (Monday to Sunday) counts when the person logged at least their weekly
// target of runs in it (sport 'run', km > 0, dated). Rules:
//  * weeks before the week of the person's start are ignored; undated imported runs use their `week` override, mapped to that
//    plan week's Monday through the person's start; runs dated after today are ignored.
//  * the target is per week: for a calendar week that maps to a plan week of the person (calendar mode; the plan week that
//    contains the week's Thursday, first week clamped to the start) it is min(configured-or-default target, number of non-optional
//    planned runs of that plan week: goal km > 0 after `goals` overrides, minus skipped sessions). So a person who does exactly what
//    the plan asks (race week: 2 runs) never loses the streak. Weeks outside the plan, in rolling mode, or with no planned run use
//    the configured/default target unchanged. A skipped session is a run id or `w<week>-<runType>` listed in state.skipped.
//  * a week fully inside pauses is skipped (neither counts nor breaks); a week that is only partly paused counts when met and
//    is skipped (not broken) when not met.
//  * the week in progress counts once it is met but never breaks the streak while it is still running.
// -> { current, best, thisWeek: { runs, target, met, paused }, target }
//    top-level `target` = configured/default weekly target; `thisWeek.target` = the target of the week in progress (see above).
export function weekStreak({ log, person, state, plan = PLAN, goals = {}, todayISO = nowISO() } = {}) {
  const p = person === 'a' || person === 'b' ? person : null;
  const target = p ? weeklyTargetFor(p, state, plan) : defaultWeeklyTarget(plan);
  const empty = { current: 0, best: 0, thisWeek: { runs: 0, target, met: false, paused: false }, target };
  if (!p || !isValidISODate(todayISO)) return empty;

  const entries = Array.isArray(log) ? log.filter(e => e && typeof e === 'object') : [];
  const own = stateOf(state, p); // normalised once
  const start = effectiveStartFor(p, own, entries, todayISO);
  const startMonday = mondayOf(start);
  const curMonday = mondayOf(todayISO);
  if (startMonday > curMonday) return empty; // the plan has not started yet

  const counts = new Map();
  for (const e of entries) {
    if (!e || e.person !== p || e.sport !== 'run' || !(Number(e.km) > 0)) continue;
    let monday = null;
    if (typeof e.date === 'string' && isValidISODate(e.date)) {
      if (e.date > todayISO) continue;
      monday = mondayOf(e.date);
    } else if (e.week != null && Number.isFinite(Number(e.week)) && Number(e.week) >= 1) {
      monday = mondayOf(addDays(start, (Math.floor(Number(e.week)) - 1) * 7));
    }
    if (!monday || monday < startMonday || monday > curMonday) continue;
    counts.set(monday, (counts.get(monday) || 0) + 1);
  }

  // Target of the calendar week starting `monday`: capped by what the plan asks that week (calendar mode only).
  const targetOf = monday => {
    if (own.mode !== 'calendar') return target;
    const thursday = addDays(monday, 3);
    const n = weekForDate(start, thursday < start ? start : thursday);
    const pw = (plan || []).find(w => w.n === n);
    if (!pw) return target;
    const planned = ((pw.runs && pw.runs[p]) || []).filter(r =>
      goalKm(r, goals) > 0 && !own.skipped.includes(r.id) && !own.skipped.includes(`w${n}-${r.runType}`)).length;
    return planned > 0 ? Math.min(target, planned) : target;
  };

  const weekCount = daysBetween(startMonday, curMonday) / 7; // whole number: both are Mondays
  let streak = 0, best = 0;
  for (let i = 0; i <= weekCount; i++) {
    const monday = addDays(startMonday, i * 7);
    const runs = counts.get(monday) || 0;
    const pausedDays = pausedDaysOf(own.pauses, monday);
    if (pausedDays === 7) continue;
    if (runs >= targetOf(monday)) { streak++; if (streak > best) best = streak; }
    else if (i < weekCount && pausedDays === 0) streak = 0; // a finished, unpaused week below target breaks it
  }
  const runs = counts.get(curMonday) || 0;
  const curTarget = targetOf(curMonday);
  return {
    current: streak,
    best,
    thisWeek: { runs, target: curTarget, met: runs >= curTarget, paused: pausedDaysOf(own.pauses, curMonday) === 7 },
    target
  };
}
