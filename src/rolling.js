// The rolling-plan engine (flexible plan, phase 2; docs/FLEXIBLE_PLAN.md §9 is the API reference).
// In rolling mode a person's progress is NOT "which calendar week is it" but "which sessions did my runs cover": the plan is
// flattened into an ordered queue of sessions, the person's logged runs are matched to it, and Next up is the first open session.
//
// Pure: no Vue, no Firebase, no DOM, no clock (today is always passed in). Imported by the app, the Cloudflare Worker bundle
// (through recommend.js) and node tests. It imports planModel.js, which imports this file back for buildWeeksFor; both only use
// each other's exports inside functions (never at module load), so the cycle is harmless.
import { PLAN, PLAN_RUN_BY_ID, RUN_TYPE_BY_KEY } from './plan.js';
import { goalKm, addDays, daysBetween, isValidISODate, todayISO as nowISO, FREE_SESSION } from './scoring.js';
import { personPlanState, buildWeeksFor, effectiveStartFor, validatePlanPatch } from './planModel.js';

/* ---------- constants ---------- */

// A planned session counts as done when the matched run reaches this share of its km (shared with recommend.js).
export const DONE_THRESHOLD = 0.9;
// A run may take one of the next N unmatched sessions (earliest of its run type), never one further away.
export const ROLLING_LOOKAHEAD = 6;
// Training slots per week assumed when the person has not set training days.
export const DEFAULT_SESSIONS_PER_WEEK = 3;

const round3 = x => Math.round(x * 1000) / 1000;
const num = v => { const n = Number(v); return Number.isFinite(n) ? n : 0; };
const validDate = v => typeof v === 'string' && isValidISODate(v);

/* ---------- sessions ---------- */

// Does `skipped` (run ids, 'w<week>-<runType>' aliases) cover this session? Repeat passes (suffix '~r2') have their own ids and aliases.
function isSkipped(skippedSet, id, week, runType, repeat) {
  return skippedSet.has(id) || skippedSet.has(`w${week}-${runType}${repeat ? '~r2' : ''}`);
}

// Flattens the plan weeks of ONE person into the ordered queue of sessions.
//   buildSessions(plan, goals, personState, person = 'a')   or   buildSessions({ plan, goals, state, person })
//   personState: that person's plan state (or the { a, b } states together with `person`, or the raw stored node).
// -> [{ id, week, index, runId, runType, type, detail, km, mult, optional, skipped, repeat }]
//   * id: the plan run id ('1-7-1-a'); the repeat pass of a repeated week (state.repeatWeeks) appends '~r2' ('1-7-1-a~r2').
//     Goals (km overrides) are keyed by `runId`, the original run id, for both passes.
//   * index: position in the returned list (skipped sessions included, so it is stable under skips).
//   * km: the effective goal (goalKm); optional = km <= 0 (e.g. the race-week shakeout).
//   * skipped: removed from the queue (never matched, never open, never counted), but kept in the list so the UI can show it.
//   * repeat: true for the second pass of a repeated week, which follows right after the original week.
export function buildSessions(plan, goals, personState, person) {
  if (plan && !Array.isArray(plan) && typeof plan === 'object') ({ plan, goals, state: personState, person } = plan);
  const weeks = Array.isArray(plan) ? plan : PLAN;
  const p = person === 'b' ? 'b' : 'a';
  const st = personPlanState(personState, p);
  const skippedSet = new Set(st.skipped);
  const repeats = new Set(st.repeatWeeks);
  const out = [];
  const push = (r, w, repeat) => {
    const km = goalKm(r, goals || {});
    const id = repeat ? `${r.id}~r2` : r.id;
    out.push({
      id, week: w.n, index: out.length, runId: r.id, runType: r.runType, type: r.type, detail: r.detail || '', km, mult: r.mult,
      optional: !(km > 0), skipped: isSkipped(skippedSet, id, w.n, r.runType, repeat), repeat
    });
  };
  for (const w of weeks) {
    const runs = (w.runs && w.runs[p]) || [];
    for (const r of runs) push(r, w, false);
    if (repeats.has(w.n)) for (const r of runs) push(r, w, true);
  }
  return out;
}

// 'Tempo · Week 7' ('Tempo · Week 7 (repeat)' for the second pass).
export const sessionLabel = s => (s ? `${s.type} · Week ${s.week}${s.repeat ? ' (repeat)' : ''}` : '');

/* ---------- matching ---------- */

const isRunEntry = e => !!e && typeof e === 'object' && e.sport === 'run' && num(e.km) > 0 && e.id != null;
const weekOverride = e => {
  const w = Number(e.week);
  return e.week != null && Number.isFinite(w) && w >= 1 ? Math.floor(w) : null;
};
const cmpStr = (a, b) => (a < b ? -1 : a > b ? 1 : 0);
// (date, ts, id): undated entries sort first.
const cmpDated = (x, y) => cmpStr(x.date || '', y.date || '') || (num(x.ts) - num(y.ts)) || cmpStr(String(x.id), String(y.id));

// Matches a person's logged runs to the session queue. Pure, deterministic, independent of the order of `entries`.
//   matchRuns({ sessions, entries, personState, todayISO, lookahead = 6, startDate?, person? })
//   entries: the person's activities (anything that is not a run with km > 0 is ignored; with `person` other people's are too).
//   Runs are processed in this order, each taking at most one session and each session at most one run:
//     0. runs pinned to 'free' (`entry.session === 'free'`) are never matched;
//     1. pinned runs (`entry.session` = a session id that exists, is not skipped and is not pinned by an earlier run);
//     2. runs with a plan-week override (`entry.week`, e.g. undated imports) go to the first open session of that week with the
//        same run type, else the open session with the closest km, else stay free;
//     3. dated runs, by (date, ts, id): a run with a known run type takes the earliest unmatched session of the SAME run type among
//        the next `lookahead` unmatched sessions; a run with no / unknown run type takes the one among them with the closest km;
//     4. everything else stays free (it still earns points elsewhere).
//   A run is DONE for its session at >= DONE_THRESHOLD of its km, shorter runs are `partial` (they still consume the session).
// -> { bySession: { [sessionId]: { entryId, km, partial } }, byEntry: { [entryId]: { sessionId, week, partial, pinned } },
//      free: [entryId], firstOpenIndex (index in `sessions` of the first unmatched non-optional session, -1 = none),
//      doneCount (non-optional, done), partialCount, openCount (non-optional, unmatched), totalCount (non-optional, not skipped),
//      behind (sessions behind pace, see behindSessions; 0 without a start date), lookahead }
export function matchRuns({ sessions = [], entries = [], personState, todayISO = nowISO(), lookahead = ROLLING_LOOKAHEAD, startDate = null, person } = {}) {
  const look = Number.isInteger(lookahead) && lookahead >= 1 ? lookahead : ROLLING_LOOKAHEAD;
  const active = sessions.filter(s => !s.skipped);
  const activeById = new Map(active.map(s => [s.id, s]));
  const bySession = {};
  const byEntry = {};
  const taken = new Set();

  const runs = (Array.isArray(entries) ? entries : []).filter(e => isRunEntry(e) && (person ? e.person === person : true)).sort(cmpDated);
  // Runs explicitly pinned to 'free' never take a session (they stay in `free`, still earning points).
  const done = new Set(runs.filter(e => e.session === FREE_SESSION).map(e => e.id));
  const take = (s, e, pinned) => {
    const km = num(e.km);
    const partial = !(s.optional || km + 1e-9 >= DONE_THRESHOLD * s.km);
    bySession[s.id] = { entryId: e.id, km, partial };
    byEntry[e.id] = { sessionId: s.id, week: s.week, partial, pinned };
    taken.add(s.id);
    done.add(e.id);
  };
  const unmatched = () => active.filter(s => !taken.has(s.id));
  const closest = (list, km) => list.reduce((best, s) => (best === null || Math.abs(s.km - km) < Math.abs(best.km - km) ? s : best), null);

  // 1. pins
  for (const e of runs) {
    const s = typeof e.session === 'string' ? activeById.get(e.session) : null;
    if (s && !taken.has(s.id)) take(s, e, true);
  }
  // 2. plan-week overrides (week, ts, id)
  const overridden = runs.filter(e => !done.has(e.id) && weekOverride(e) !== null)
    .sort((x, y) => (weekOverride(x) - weekOverride(y)) || (num(x.ts) - num(y.ts)) || cmpStr(String(x.id), String(y.id)));
  for (const e of overridden) {
    const inWeek = unmatched().filter(s => s.week === weekOverride(e));
    const s = inWeek.find(c => c.runType === e.runType) || closest(inWeek.filter(c => c.km > 0), num(e.km));
    if (s) take(s, e, false);
  }
  // 3. dated runs, in order
  for (const e of runs) {
    if (done.has(e.id) || weekOverride(e) !== null || !validDate(e.date)) continue;
    const window = unmatched().slice(0, look);
    const s = RUN_TYPE_BY_KEY[e.runType] ? window.find(c => c.runType === e.runType) : closest(window, num(e.km));
    if (s) take(s, e, false);
  }
  const free = runs.filter(e => !byEntry[e.id]).map(e => e.id);

  const required = active.filter(s => !s.optional);
  const doneCount = required.filter(s => bySession[s.id] && !bySession[s.id].partial).length;
  const partialCount = required.filter(s => bySession[s.id] && bySession[s.id].partial).length;
  const openCount = required.filter(s => !bySession[s.id]).length;
  const first = sessions.findIndex(s => !s.skipped && !s.optional && !bySession[s.id]);
  const out = { bySession, byEntry, free, firstOpenIndex: first, doneCount, partialCount, openCount, totalCount: required.length, behind: 0, lookahead: look };
  const st = personState ? personPlanState(personState, person) : null;
  const start = startDate || (st && (st.startDate || st.fallbackStartDate)) || null;
  if (st && start) out.behind = behindSessions({ sessions, match: out, personState: st, startDate: start, todayISO });
  return out;
}

// The first open (unmatched, non-optional, not skipped) session, or null.
export function nextOpenSession(sessions, match) {
  return match && match.firstOpenIndex >= 0 ? sessions[match.firstOpenIndex] || null : null;
}

// 'Counts for Tempo, Week 7' | 'Counts for Tempo, Week 7 (partly)' | 'Free run'
export function explainMatch(entryId, match, sessions) {
  const m = match && match.byEntry && match.byEntry[entryId];
  if (!m) return 'Free run';
  const s = (sessions || []).find(x => x.id === m.sessionId);
  if (!s) return 'Free run';
  return `Counts for ${s.type}, Week ${s.week}${s.repeat ? ' (repeat)' : ''}${m.partial ? ' (partly)' : ''}`;
}

// What a NEW run (or an edit of an existing one) would be matched to; used by the log form.
//   suggestSession({ person, draft: { runType, km, date, id?, session? }, sessions, match, entries?, personState?, todayISO?, lookahead? })
//   * draft.session (an explicit pin): that session, `alreadyMatched` = another run already holds it (the pin would then be ignored).
//   * with `entries` (the person's activities) the matching is re-run with the draft added (draft.id = the entry being edited, which
//     is replaced): exact, whatever the draft's date. Without them the draft is assumed to be the newest run and takes
//     the free sessions left in `match` (the usual "log today's run" case).
//   `alreadyMatched` is also true when an edited run (draft.id) is already matched to the suggested session.
// -> { sessionId, week, label: 'Tempo · Week 7', alreadyMatched?: true } | null (a free run)
export function suggestSession({ person, draft, sessions = [], match, entries, personState, todayISO = nowISO(), lookahead } = {}) {
  const d = draft || {};
  const byId = new Map(sessions.map(s => [s.id, s]));
  const asResult = (s, already) => ({ sessionId: s.id, week: s.week, label: sessionLabel(s), ...(already ? { alreadyMatched: true } : {}) });
  const before = match && match.byEntry && d.id != null ? match.byEntry[d.id] : null;

  if (d.session === FREE_SESSION) return null; // pinned as a free run
  if (typeof d.session === 'string' && d.session) {
    const s = byId.get(d.session);
    if (!s || s.skipped) return null;
    const holder = match && match.bySession && match.bySession[s.id];
    return asResult(s, !!holder && holder.entryId !== d.id);
  }
  const km = num(d.km) > 0 ? num(d.km) : 0.001;
  const look = Number.isInteger(lookahead) && lookahead >= 1 ? lookahead : (match && match.lookahead) || ROLLING_LOOKAHEAD;

  if (Array.isArray(entries)) {
    const draftEntry = { id: '__draft__', person, sport: 'run', runType: d.runType, km, date: validDate(d.date) ? d.date : (todayISO || '9999-12-31'), ts: Number.MAX_SAFE_INTEGER };
    const rest = entries.filter(e => !(d.id != null && e.id === d.id));
    const m = matchRuns({ sessions, entries: [...rest, draftEntry], personState, todayISO, lookahead: look, person });
    const hit = m.byEntry.__draft__;
    const s = hit && byId.get(hit.sessionId);
    return s ? asResult(s, !!before && before.sessionId === s.id) : null;
  }
  // Approximation from the existing match: the newest run takes the earliest fitting free session in the window.
  const taken = (match && match.bySession) || {};
  const free = sessions.filter(s => !s.skipped && (!taken[s.id] || (d.id != null && taken[s.id].entryId === d.id)));
  const window = free.slice(0, look);
  const s = RUN_TYPE_BY_KEY[d.runType]
    ? window.find(c => c.runType === d.runType)
    : window.reduce((best, c) => (best === null || Math.abs(c.km - km) < Math.abs(best.km - km) ? c : best), null);
  return s ? asResult(s, !!before && before.sessionId === s.id) : null;
}

/* ---------- pace: how many sessions "should" be done ---------- */

// Paused days d with from <= d < toExclusive (pauses are the normalised, merged ranges of a plan state).
function pausedDaysIn(pauses, fromISO, toExclusiveISO) {
  if (toExclusiveISO <= fromISO) return 0;
  const last = addDays(toExclusiveISO, -1);
  let n = 0;
  for (const p of pauses) {
    const lo = p.from > fromISO ? p.from : fromISO;
    const hi = p.to < last ? p.to : last;
    if (hi >= lo) n += daysBetween(lo, hi) + 1;
  }
  return n;
}

// Sessions that, under the calendar pace implied by the start date and race date, should already be done today.
//  * With a race date (after the start): the non-optional, non-skipped sessions are spread evenly over the NOT PAUSED days from
//    the start up to the race: due = floor(total * elapsedActiveDays / availableActiveDays), where only days strictly before today
//    count as elapsed. The race session itself is never due before the race date (due <= total - 1 until then).
//  * Without a race date: the plan's own calendar: week n starts start + 7 (n - 1) and all sessions of a week are due once that
//    week has completely passed; paused days do not count as elapsed, so a pause shifts every later week; a repeated week takes one
//    more calendar week (its repeat pass is its own block right after it).
//  * Before the start, or with no start date: 0.
// -> { due, total, basis: 'race' | 'calendar' | 'none' }
export function sessionsDue({ sessions = [], personState, startDate, todayISO = nowISO(), person } = {}) {
  const st = personPlanState(personState, person);
  const start = startDate || st.startDate || st.fallbackStartDate || null;
  const total = sessions.filter(s => !s.skipped && !s.optional).length;
  if (!validDate(start) || !validDate(todayISO) || total === 0) return { due: 0, total, basis: 'none' };
  const race = st.raceDate;
  if (race && daysBetween(start, race) > 0) {
    const avail = daysBetween(start, race) - pausedDaysIn(st.pauses, start, race);
    if (avail <= 0) return { due: todayISO > race ? total : 0, total, basis: 'race' };
    const lastDay = todayISO < race ? todayISO : race;
    const elapsed = lastDay > start ? daysBetween(start, lastDay) - pausedDaysIn(st.pauses, start, lastDay) : 0;
    let due = Math.min(total, Math.floor((total * elapsed) / avail + 1e-9));
    if (todayISO <= race) due = Math.min(due, Math.max(0, total - 1));
    return { due, total, basis: 'race' };
  }
  const elapsed = todayISO > start ? daysBetween(start, todayISO) - pausedDaysIn(st.pauses, start, todayISO) : 0;
  const blocks = Math.floor(elapsed / 7);
  const order = [];
  const seen = new Set();
  for (const s of sessions) {
    const key = `${s.week}:${s.repeat ? 1 : 0}`;
    if (!seen.has(key)) { seen.add(key); order.push(key); }
  }
  const dueKeys = new Set(order.slice(0, blocks));
  const due = sessions.filter(s => !s.skipped && !s.optional && dueKeys.has(`${s.week}:${s.repeat ? 1 : 0}`)).length;
  return { due, total, basis: 'calendar' };
}

// Sessions behind pace: due (sessionsDue) minus the non-optional sessions matched so far (done or partial), never negative.
export function behindSessions({ sessions = [], match, personState, startDate, todayISO = nowISO(), person } = {}) {
  const { due } = sessionsDue({ sessions, personState, startDate, todayISO, person });
  const matched = match ? (match.doneCount || 0) + (match.partialCount || 0) : 0;
  return Math.max(0, due - matched);
}

/* ---------- race feasibility ---------- */

// Do the open sessions fit between today and the race date?
//  * sessionsLeft = open non-optional sessions (the race itself included).
//  * slots = training days from today (tomorrow when `ranToday`) up to the race date: with trainingDays set, those weekdays that
//    are not paused; without, floor(days * 3 / 7) not paused days (DEFAULT_SESSIONS_PER_WEEK); the race day itself is always one slot.
// -> { daysLeft, sessionsLeft, slots, fits, shortBy, raceDate } | null when no (valid) race date is set.
export function raceFeasibility({ sessions = [], match, personState, todayISO = nowISO(), ranToday = false, person } = {}) {
  const st = personPlanState(personState, person);
  const race = st.raceDate;
  if (!race || !validDate(todayISO)) return null;
  const sessionsLeft = match ? match.openCount : sessions.filter(s => !s.skipped && !s.optional).length;
  const daysLeft = Math.max(0, daysBetween(todayISO, race));
  const first = ranToday ? addDays(todayISO, 1) : todayISO;
  let slots = 0;
  if (first <= race) {
    const lastTraining = addDays(race, -1);
    const days = first <= lastTraining ? daysBetween(first, lastTraining) + 1 : 0; // days before the race day
    const free = days - pausedDaysIn(st.pauses, first, race);
    if (st.trainingDays.length) {
      for (let i = 0; i < days; i++) {
        const d = addDays(first, i);
        const dow = new Date(`${d}T00:00:00Z`).getUTCDay();
        if (st.trainingDays.includes(dow) && !st.pauses.some(p => d >= p.from && d <= p.to)) slots++;
      }
    } else slots = Math.floor((Math.max(0, free) * DEFAULT_SESSIONS_PER_WEEK) / 7);
    slots += 1; // race day
  }
  const fits = slots >= sessionsLeft;
  return { daysLeft, sessionsLeft, slots, fits, shortBy: Math.max(0, sessionsLeft - slots), raceDate: race };
}

/* ---------- the rolling view of one person ---------- */

// Sessions + matching for one person from the whole log. -> { sessions, match, state, startDate }
export function rollingStateFor({ plan = PLAN, goals = {}, log = [], person, state, startDate, todayISO = nowISO(), lookahead } = {}) {
  const st = personPlanState(state, person);
  const sessions = buildSessions(plan, goals, st, person);
  const mine = (Array.isArray(log) ? log : []).filter(e => e && e.person === person);
  const start = startDate || effectiveStartFor(person, st, log, todayISO);
  const match = matchRuns({ sessions, entries: mine, personState: st, todayISO, lookahead, startDate: start, person });
  return { sessions, match, state: st, startDate: start };
}

// The week data of one person in rolling mode, the same shape as scoring.buildWeeks' per-person value (planModel.buildWeeksFor
// uses it for people in rolling mode). One entry per plan week, in plan order:
//  { plannedKm, doneKm, pct, status, runs, entries, behindSessions, sessionsDone, sessionsTotal, partialCount, repeated }
//   * runs: one per session of that week (a repeated week lists its repeat pass too, ids with '~r2'):
//     { id, runId, type, runType, detail, mult, km, defaultKm, skipped, repeat, matched: { entryId, km, partial } | null }
//   * plannedKm: km of the sessions that are not skipped (repeat pass included); doneKm: km of the runs matched to them;
//     entries: those runs' activities, in session order (free runs belong to no week).
//   * status: 'n/a' (nothing planned) | 'fulfilled' (every non-optional, non-skipped session is matched) | 'current' (holds the first
//     open session) | 'upcoming'. Never 'missed'.
//   * pct: 100 when fulfilled with no partial run, otherwise min(99, round(100 * doneKm / plannedKm)); null when nothing is planned.
// -> { weeks: [WeekPerson], currentIndex (plan index of the week with the first open session, -1 = nothing open),
//      sessions, match, behindSessions, nextSession }
export function rollingWeeksFor({ plan = PLAN, goals = {}, log = [], person, state, startDate, todayISO = nowISO(), lookahead } = {}) {
  const view = rollingStateFor({ plan, goals, log, person, state, startDate, todayISO, lookahead });
  const { sessions, match } = view;
  const byId = new Map((Array.isArray(log) ? log : []).filter(e => e && e.person === person).map(e => [e.id, e]));
  const next = nextOpenSession(sessions, match);
  let currentIndex = -1;
  const weeks = plan.map((w, i) => {
    if (next && next.week === w.n) currentIndex = i;
    const ses = sessions.filter(s => s.week === w.n);
    const runs = ses.map(s => {
      const base = PLAN_RUN_BY_ID[s.runId];
      const hit = match.bySession[s.id];
      return {
        id: s.id, runId: s.runId, type: s.type, runType: s.runType, detail: s.detail, mult: s.mult, km: s.km,
        defaultKm: base ? base.run.km : null, skipped: s.skipped, repeat: s.repeat, matched: hit ? { ...hit } : null
      };
    });
    const live = ses.filter(s => !s.skipped);
    const required = live.filter(s => !s.optional);
    const matched = live.filter(s => match.bySession[s.id]);
    const plannedKm = round3(live.reduce((t, s) => t + s.km, 0));
    const doneKm = round3(matched.reduce((t, s) => t + match.bySession[s.id].km, 0));
    const requiredMatched = required.filter(s => match.bySession[s.id]);
    const partialCount = required.filter(s => match.bySession[s.id] && match.bySession[s.id].partial).length;
    const fulfilled = required.length > 0 && requiredMatched.length === required.length;
    const entries = matched.map(s => byId.get(match.bySession[s.id].entryId)).filter(Boolean);
    return { plannedKm, doneKm, required, fulfilled, partialCount, runs, entries, matchedAll: requiredMatched.length, repeated: ses.some(s => s.repeat) };
  });
  const out = weeks.map((x, i) => {
    let status;
    let pct = null;
    if (x.plannedKm <= 0) status = 'n/a';
    else {
      status = x.fulfilled ? 'fulfilled' : i === currentIndex ? 'current' : 'upcoming';
      pct = x.fulfilled && x.partialCount === 0 ? 100 : Math.min(99, Math.round((100 * x.doneKm) / x.plannedKm));
    }
    return {
      plannedKm: x.plannedKm, doneKm: x.doneKm, pct, status, runs: x.runs, entries: x.entries,
      behindSessions: match.behind, sessionsDone: x.matchedAll, sessionsTotal: x.required.length, partialCount: x.partialCount, repeated: x.repeated
    };
  });
  return { weeks: out, currentIndex, sessions, match, behindSessions: match.behind, nextSession: next };
}

/* ---------- pure plan operations (patches for setPlanState) ---------- */

const fail = message => { throw new Error(message); };
const checked = patch => { const c = validatePlanPatch(patch); return c.ok ? c.patch : fail(c.error); };
const stateOnly = state => personPlanState(state, undefined);

// A skipped-list entry that refers to the same session as `id`: the id itself and the 'w<week>-<runType>' alias.
function skipAliases(id) {
  const m = /^(.*?)(~r\d+)?$/.exec(id);
  const hit = PLAN_RUN_BY_ID[m[1]];
  return hit ? [id, `w${hit.week}-${hit.run.runType}${m[2] || ''}`] : [id];
}

// Skips a session (a session id such as '1-7-1-a' or the alias 'w7-tempo'); idempotent.
export function skipSessionPatch(state, sessionId) {
  if (typeof sessionId !== 'string' || !sessionId.trim()) fail('Pick a session to skip.');
  const cur = stateOnly(state).skipped;
  const id = sessionId.trim();
  return checked({ skipped: cur.includes(id) ? [...cur] : [...cur, id] });
}

// Brings a skipped session back (removes the id and its alias).
export function unskipSessionPatch(state, sessionId) {
  if (typeof sessionId !== 'string' || !sessionId.trim()) fail('Pick a session to restore.');
  const drop = new Set(skipAliases(sessionId.trim()));
  return checked({ skipped: stateOnly(state).skipped.filter(s => !drop.has(s)) });
}

// Repeats plan week `week` once more right after it in the queue.
export function repeatWeekPatch(state, week) {
  const n = Number(week);
  if (!Number.isInteger(n) || n < 1 || n > PLAN.length) fail(`Pick a plan week from 1 to ${PLAN.length}.`);
  const cur = stateOnly(state).repeatWeeks;
  return checked({ repeatWeeks: cur.includes(n) ? [...cur] : [...cur, n] });
}

export function unrepeatWeekPatch(state, week) {
  const n = Number(week);
  return checked({ repeatWeeks: stateOnly(state).repeatWeeks.filter(w => w !== n) });
}

// Adds a pause range { from, to, note? } (overlapping pauses merge).
export function addPausePatch(state, pause) {
  const p = pause && typeof pause === 'object' ? pause : {};
  const add = { from: p.from, to: p.to, ...(p.note ? { note: p.note } : {}) };
  return checked({ pauses: [...stateOnly(state).pauses, add] });
}

// Removes the pause at `index` of the (sorted) pause list.
export function removePausePatch(state, index) {
  const cur = stateOnly(state).pauses;
  if (!Number.isInteger(index) || index < 0 || index >= cur.length) fail('That pause no longer exists.');
  return checked({ pauses: cur.filter((_, i) => i !== index) });
}

/* ---------- what switching the mode would change ---------- */

// -> { calendar: { currentWeek, fulfilledWeeks, behind }, rolling: { currentWeek, fulfilledWeeks, nextSession } } for `person` ('a').
//   calendar.behind = weeks already missed under the calendar rules; rolling.nextSession = the first open session or null;
//   currentWeek = plan week number or null (plan not started / finished).
export function previewModeSwitch({ plan = PLAN, goals = {}, log = [], state, todayISO = nowISO(), person = 'a' } = {}) {
  const st = personPlanState(state, person);
  const weeksIn = mode => buildWeeksFor({ plan, goals, log, state: { ...st, mode }, todayISO, viewer: person });
  const cal = weeksIn('calendar');
  const rol = weeksIn('rolling');
  const count = (weeks, status) => weeks.filter(w => w[person].status === status).length;
  const cur = weeks => { const w = weeks.find(x => x.current); return w ? w.n : null; };
  const startDate = effectiveStartFor(person, st, log, todayISO);
  const view = rollingStateFor({ plan, goals, log, person, state: st, startDate, todayISO });
  return {
    calendar: { currentWeek: cur(cal), fulfilledWeeks: count(cal, 'fulfilled'), behind: count(cal, 'missed') },
    rolling: { currentWeek: cur(rol), fulfilledWeeks: count(rol, 'fulfilled'), nextSession: nextOpenSession(view.sessions, view.match) }
  };
}
