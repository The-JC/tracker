// Pure scoring / dating / aggregation functions. No DOM, no Firebase, no Vue:
// everything takes plain data (and an explicit "today") so it is unit-testable in node.
//
// Conventions
//  * Dates are local calendar dates as 'YYYY-MM-DD' strings. All arithmetic goes through
//    Date.UTC so daylight-saving changes can never shift a day.
//  * "km" in aggregates means distance of run + hike entries; "runKm" is runs only.
//  * Legacy imported entries have date:null. They count for points, totals and (through
//    their explicit `week`) plan weeks, but never for streaks or the weekly series.
import { RUN_TYPE_BY_KEY, SPORT_BY_KEY } from './plan.js';

const DAY = 86400000;

/* ---------- date helpers ---------- */

const pad = n => String(n).padStart(2, '0');

export function isValidISODate(s) {
  if (typeof s !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(s)) return false;
  const [y, m, d] = s.split('-').map(Number);
  const t = new Date(Date.UTC(y, m - 1, d));
  return t.getUTCFullYear() === y && t.getUTCMonth() === m - 1 && t.getUTCDate() === d;
}

// ISO string -> UTC-midnight milliseconds.
function utcMs(iso) {
  const [y, m, d] = iso.split('-').map(Number);
  return Date.UTC(y, m - 1, d);
}

function isoFromUtcMs(ms) {
  const t = new Date(ms);
  return `${t.getUTCFullYear()}-${pad(t.getUTCMonth() + 1)}-${pad(t.getUTCDate())}`;
}

// Local calendar date of a Date / timestamp.
export function toISODate(dateOrTs = new Date()) {
  const d = dateOrTs instanceof Date ? dateOrTs : new Date(dateOrTs);
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
}

export const todayISO = () => toISODate(new Date());

export function addDays(iso, n) { return isoFromUtcMs(utcMs(iso) + n * DAY); }

export function daysBetween(fromISO, toISO) { return Math.round((utcMs(toISO) - utcMs(fromISO)) / DAY); }

// Monday (ISO week start) of the week containing `iso`.
export function mondayOf(iso) {
  const dow = new Date(utcMs(iso)).getUTCDay(); // 0 = Sunday
  return addDays(iso, -((dow + 6) % 7));
}

/* ---------- number formatting ---------- */

const round1 = x => Math.round(x * 10) / 10;
const round3 = x => Math.round(x * 1000) / 1000;

export function formatKm(km) {
  if (!Number.isFinite(km)) return '–';
  const s = round1(km).toFixed(1);
  return s.endsWith('.0') ? s.slice(0, -2) : s;
}

export function formatPoints(p) { return Number.isFinite(p) ? formatKm(p) : '–'; }

// min/km (e.g. 5.5) -> "5:30". Null/invalid -> "–". Add the "/km" unit in the UI.
export function formatPace(minPerKm) {
  if (!Number.isFinite(minPerKm) || minPerKm <= 0) return '–';
  let m = Math.floor(minPerKm);
  let s = Math.round((minPerKm - m) * 60);
  if (s === 60) { m += 1; s = 0; }
  return `${m}:${pad(s)}`;
}

// minutes -> "45 min", "1 h 05 min", "2 h". Null/invalid -> "–".
export function formatDuration(min) {
  if (!Number.isFinite(min) || min <= 0) return '–';
  const total = Math.round(min);
  if (total < 60) return `${total} min`;
  const h = Math.floor(total / 60);
  const m = total % 60;
  return m ? `${h} h ${pad(m)} min` : `${h} h`;
}

/* ---------- points & pace ---------- */

// run: km x run-type multiplier (default easy). Other sports: see SPORTS (rate per km or per 30 min).
export function pointsFor(entry) {
  if (!entry) return 0;
  const sport = SPORT_BY_KEY[entry.sport];
  if (!sport) return 0;
  if (sport.key === 'run') {
    const km = Number(entry.km);
    if (!(km > 0)) return 0;
    const type = RUN_TYPE_BY_KEY[entry.runType] || RUN_TYPE_BY_KEY.easy;
    return km * type.mult;
  }
  const amount = Number(sport.requires === 'km' ? entry.km : entry.durationMin);
  if (!(amount > 0)) return 0;
  return (amount * sport.rate) / sport.per;
}

// Minutes per km, or null when distance or duration is missing.
export function paceMinPerKm(entry) {
  if (!entry) return null;
  const km = Number(entry.km);
  const min = Number(entry.durationMin);
  return km > 0 && min > 0 ? min / km : null;
}

/* ---------- plan weeks ---------- */

// Plan week (1-based, unclamped: <1 before the start, >30 after the plan) of a date.
export function weekForDate(startDateISO, dateISO) {
  return Math.floor(daysBetween(startDateISO, dateISO) / 7) + 1;
}

// settings start date if set; else Monday of the earliest dated run's week; else this week's Monday.
export function effectiveStartDate(settingsStartDate, log, today = todayISO()) {
  if (settingsStartDate && isValidISODate(settingsStartDate)) return settingsStartDate;
  let earliest = null;
  for (const e of log || []) {
    if (e.sport === 'run' && e.date && (earliest === null || e.date < earliest)) earliest = e.date;
  }
  return mondayOf(earliest || today);
}

// Plan week an entry counts for: explicit `week` override, else derived from its date, else null.
export function weekOfEntry(entry, startDate) {
  if (!entry) return null;
  const w = Number(entry.week);
  if (entry.week != null && Number.isFinite(w) && w >= 1) return Math.floor(w);
  if (entry.date && startDate) return weekForDate(startDate, entry.date);
  return null;
}

// Goal km of a plan run: the override string if non-empty and numeric (so "0" means 0),
// otherwise the plan default (null default -> 0). An empty-string override means "use default"
// because the legacy app stored every goal input, including untouched empty ones.
export function goalKm(run, goals) {
  const raw = goals ? goals[run.id] : undefined;
  if (raw != null && String(raw).trim() !== '') {
    const n = parseFloat(String(raw).replace(',', '.'));
    if (Number.isFinite(n) && n >= 0) return n;
  }
  return run.km == null ? 0 : run.km;
}

// Compare two entries: newest first (date desc, ties and null dates by creation ts desc; null dates last).
export function compareLog(x, y) {
  const dx = x.date || '', dy = y.date || '';
  if (dx !== dy) return dx < dy ? 1 : -1;
  return (y.ts || 0) - (x.ts || 0);
}

export const sortLog = log => [...log].sort(compareLog);

// Builds the 30 week summaries.
// -> [{ n, kind, tag, current, startDate, endDate, a: WeekPerson, b: WeekPerson }]
// WeekPerson = { plannedKm, doneKm, pct|null, status, runs:[{id,type,runType,detail,km,mult,defaultKm}], entries:[ActivityEntry] }
//  * runs[].km is the effective goal (see goalKm); defaultKm is the plan default (null if none).
//  * doneKm = km of this person's `run` entries mapped to the week; entries = all their entries mapped to it.
//  * pct = min(100, round(100*done/planned)), but never 100 unless done >= planned; null when planned = 0.
//  * status: 'n/a' (planned 0) | 'fulfilled' | 'missed' (week over) | 'current' | 'upcoming'.
export function buildWeeks(plan, goals, log, startDate, today = todayISO()) {
  const curWeek = weekForDate(startDate, today);
  const byWeek = { a: {}, b: {} };
  for (const e of log || []) {
    if (e.person !== 'a' && e.person !== 'b') continue;
    const n = weekOfEntry(e, startDate);
    if (n == null) continue;
    (byWeek[e.person][n] ||= []).push(e);
  }
  return plan.map(w => {
    const startD = addDays(startDate, (w.n - 1) * 7);
    const endD = addDays(startD, 6);
    const over = today > endD;
    const out = { n: w.n, kind: w.kind, tag: w.tag, current: w.n === curWeek, startDate: startD, endDate: endD };
    for (const p of ['a', 'b']) {
      const runs = w.runs[p].map(r => ({
        id: r.id, type: r.type, runType: r.runType, detail: r.detail, mult: r.mult,
        km: goalKm(r, goals), defaultKm: r.km
      }));
      const plannedKm = round3(runs.reduce((s, r) => s + r.km, 0));
      const entries = byWeek[p][w.n] || [];
      const doneKm = round3(entries.reduce((s, e) => s + (e.sport === 'run' && e.km > 0 ? Number(e.km) : 0), 0));
      let pct = null;
      let status;
      if (plannedKm <= 0) {
        status = 'n/a';
      } else {
        const full = doneKm + 1e-9 >= plannedKm;
        pct = full ? 100 : Math.min(99, Math.round((100 * doneKm) / plannedKm));
        status = full ? 'fulfilled' : over ? 'missed' : out.current ? 'current' : 'upcoming';
      }
      out[p] = { plannedKm, doneKm, pct, status, runs, entries };
    }
    return out;
  });
}

/* ---------- aggregates ---------- */

const KM_SPORTS = new Set(['run', 'hike']);
const kmOf = e => (KM_SPORTS.has(e.sport) && e.km > 0 ? Number(e.km) : 0);
const emptyPerson = () => ({ a: [], b: [] });

function splitByPerson(log) {
  const by = emptyPerson();
  for (const e of log || []) if (e.person === 'a' || e.person === 'b') by[e.person].push(e);
  return by;
}

// Consecutive days with >=1 dated activity, ending today (or yesterday if nothing logged yet today).
export function streakDays(entries, today = todayISO()) {
  const days = new Set();
  for (const e of entries) if (e.date && e.date <= today) days.add(e.date);
  let cursor = days.has(today) ? today : addDays(today, -1);
  let n = 0;
  while (days.has(cursor)) { n++; cursor = addDays(cursor, -1); }
  return n;
}

// Run + hike km per Monday-based week for the last `count` weeks, oldest first, ending with this week.
export function weeklyKm(entries, today = todayISO(), count = 8) {
  const thisMonday = mondayOf(today);
  const out = [];
  for (let i = count - 1; i >= 0; i--) out.push({ weekStart: addDays(thisMonday, -7 * i), km: 0 });
  const idx = Object.fromEntries(out.map((w, i) => [w.weekStart, i]));
  for (const e of entries) {
    if (!e.date) continue;
    const i = idx[mondayOf(e.date)];
    if (i !== undefined) out[i].km += kmOf(e);
  }
  out.forEach(w => { w.km = round3(w.km); });
  return out;
}

// -> { a: Stats, b: Stats }; Stats = { totalKm, totalPoints, count, longestRunKm, bestPaceMinPerKm|null, streakDays, weeklyKm }
export function stats(log, today = todayISO()) {
  const by = splitByPerson(log);
  const result = {};
  for (const p of ['a', 'b']) {
    const es = by[p];
    let longest = 0, best = null;
    for (const e of es) {
      if (e.sport !== 'run') continue;
      if (e.km > longest) longest = Number(e.km);
      const pace = e.km >= 1 ? paceMinPerKm(e) : null;
      if (pace !== null && (best === null || pace < best)) best = pace;
    }
    result[p] = {
      totalKm: round3(es.reduce((s, e) => s + kmOf(e), 0)),
      totalPoints: round3(es.reduce((s, e) => s + pointsFor(e), 0)),
      count: es.length,
      longestRunKm: longest,
      bestPaceMinPerKm: best,
      streakDays: streakDays(es, today),
      weeklyKm: weeklyKm(es, today)
    };
  }
  return result;
}

// -> { a: { points, km, runKm, count, planPct, streak }, b: {...} }
// planPct = overall plan progress 0..100: sum over weeks of min(done, planned) / sum of planned km.
export function scoreboard(log, weeks, today = todayISO()) {
  const by = splitByPerson(log);
  const result = {};
  for (const p of ['a', 'b']) {
    const es = by[p];
    let planned = 0, done = 0;
    for (const w of weeks || []) {
      planned += w[p].plannedKm;
      done += Math.min(w[p].doneKm, w[p].plannedKm);
    }
    result[p] = {
      points: round3(es.reduce((s, e) => s + pointsFor(e), 0)),
      km: round3(es.reduce((s, e) => s + kmOf(e), 0)),
      runKm: round3(es.reduce((s, e) => s + (e.sport === 'run' && e.km > 0 ? Number(e.km) : 0), 0)),
      count: es.length,
      planPct: planned > 0 ? Math.min(100, Math.round((100 * done) / planned)) : 0,
      streak: streakDays(es, today)
    };
  }
  return result;
}

/* ---------- relative dates ---------- */

const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
const WEEKDAYS = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday'];

// 'Today' | 'Yesterday' | 'Tomorrow' | weekday name (2-6 days ago) | '12 Mar' | '12 Mar 2025'. null -> ''.
export function relativeDate(dateISO, today = todayISO()) {
  if (!dateISO || !isValidISODate(dateISO)) return '';
  const diff = daysBetween(dateISO, today);
  if (diff === 0) return 'Today';
  if (diff === 1) return 'Yesterday';
  if (diff === -1) return 'Tomorrow';
  if (diff >= 2 && diff <= 6) return WEEKDAYS[new Date(utcMs(dateISO)).getUTCDay()];
  const [y, m, d] = dateISO.split('-').map(Number);
  const base = `${d} ${MONTHS[m - 1]}`;
  return String(y) === today.slice(0, 4) ? base : `${base} ${y}`;
}

// 'YYYY-MM-DD' -> '12 Mar 2026' (always absolute).
export function formatDateLong(dateISO) {
  if (!isValidISODate(dateISO)) return '';
  const [y, m, d] = dateISO.split('-').map(Number);
  return `${d} ${MONTHS[m - 1]} ${y}`;
}

/* ---------- logging an activity ---------- */

const TITLE_NOUN = { run: 'run', hike: 'hike', cycle: 'ride', swim: 'swim', strength: 'strength session', workout: 'workout' };

// "Morning run", "Afternoon ride", ... from the local hour of `now`.
export function defaultTitle(sport, now = new Date()) {
  const h = now.getHours();
  const part = h < 5 ? 'Night' : h < 12 ? 'Morning' : h < 17 ? 'Afternoon' : h < 21 ? 'Evening' : 'Night';
  return `${part} ${TITLE_NOUN[sport] || 'activity'}`;
}

const posNumber = v => {
  if (v === '' || v == null) return null;
  const n = typeof v === 'number' ? v : parseFloat(String(v).replace(',', '.'));
  return Number.isFinite(n) && n > 0 ? n : NaN;
};

// Validates + normalises the input of the log form.
// -> { ok:true, value:{ sport, runType?, title, date, km?, durationMin?, note? } } | { ok:false, error }
// Rules: sport must be known; date must be a valid ISO date; the sport's required amount (km or
// minutes) must be > 0; km (runs/hikes) and durationMin (any) are optional extras otherwise.
export function validateActivityInput(input, now = new Date()) {
  const fail = error => ({ ok: false, error });
  if (!input) return fail('Nothing to save.');
  const sport = SPORT_BY_KEY[input.sport];
  if (!sport) return fail('Pick a sport.');
  if (!isValidISODate(input.date)) return fail('Pick a valid date.');
  const km = posNumber(input.km);
  const durationMin = posNumber(input.durationMin);
  if (Number.isNaN(km)) return fail('Distance must be a positive number.');
  if (Number.isNaN(durationMin)) return fail('Duration must be a positive number of minutes.');
  if (sport.requires === 'km' && km === null) return fail('Enter the distance in km.');
  if (sport.requires === 'durationMin' && durationMin === null) return fail('Enter the duration in minutes.');
  const value = {
    sport: sport.key,
    title: String(input.title || '').trim().slice(0, 80) || defaultTitle(sport.key, now),
    date: input.date
  };
  if (sport.key === 'run') value.runType = RUN_TYPE_BY_KEY[input.runType] ? input.runType : 'easy';
  if (km !== null && (sport.key === 'run' || sport.key === 'hike')) value.km = round3(km);
  if (durationMin !== null) value.durationMin = round3(durationMin);
  const note = String(input.note || '').trim().slice(0, 500);
  if (note) value.note = note;
  return { ok: true, value };
}
