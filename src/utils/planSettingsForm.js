// Pure helpers behind the "My plan" screen (PlanSettings.vue) and the Plan tab header. No Vue, no DOM, no clock
// (today is always passed in): node-tested in tests/planSettingsForm.test.mjs. Dates are local 'YYYY-MM-DD'; all date
// arithmetic goes through scoring.js (UTC based, so a daylight-saving change never shifts a day).
import { addDays, daysBetween, mondayOf, isValidISODate } from '../scoring.js';
import { PLAN_RUN_BY_ID, RUN_TYPE_BY_KEY, TOTAL_WEEKS } from '../plan.js';
import { MAX_WEEKLY_TARGET } from '../planModel.js';

/* ---------- training days ---------- */

// Chips Monday first (the app's weeks run Monday to Sunday); `day` is the stored value 0 = Sunday ... 6 = Saturday.
export const WEEKDAY_CHIPS = Object.freeze([
  { day: 1, short: 'Mon', long: 'Monday' }, { day: 2, short: 'Tue', long: 'Tuesday' }, { day: 3, short: 'Wed', long: 'Wednesday' },
  { day: 4, short: 'Thu', long: 'Thursday' }, { day: 5, short: 'Fri', long: 'Friday' }, { day: 6, short: 'Sat', long: 'Saturday' },
  { day: 0, short: 'Sun', long: 'Sunday' }
]);

// Toggles `day` in the list; the result is unique and ascending (0 = Sunday first, like planModel.normalizeTrainingDays).
export function toggleTrainingDay(days, day) {
  const set = new Set(Array.isArray(days) ? days : []);
  if (set.has(day)) set.delete(day); else set.add(day);
  return [...set].filter(d => Number.isInteger(d) && d >= 0 && d <= 6).sort((x, y) => x - y);
}

// 'Tue, Thu, Sat' in Monday-first order, '' for none.
export function trainingDaysText(days) {
  const set = new Set(Array.isArray(days) ? days : []);
  return WEEKDAY_CHIPS.filter(c => set.has(c.day)).map(c => c.short).join(', ');
}

/* ---------- weekly target ---------- */

// Stepper: keeps the target in 1..MAX_WEEKLY_TARGET. `current` null (automatic) starts from `fallback`.
export function stepTarget(current, delta, fallback = 3) {
  const base = Number.isInteger(current) ? current : fallback;
  return Math.min(MAX_WEEKLY_TARGET, Math.max(1, base + delta));
}

/* ---------- race date ---------- */

// Days / whole weeks from today to the race. past = the race day is over; today = it is today.
// -> { days, weeks, extraDays, today, past }   (days is negative when past)
export function raceCountdown(todayISO, raceISO) {
  if (!isValidISODate(todayISO) || !isValidISODate(raceISO)) return null;
  const days = daysBetween(todayISO, raceISO);
  const abs = Math.abs(days);
  return { days, weeks: Math.floor(abs / 7), extraDays: abs % 7, today: days === 0, past: days < 0 };
}

const plural = (n, one, many = `${one}s`) => `${n} ${n === 1 ? one : many}`;

// '12 weeks and 3 days left' | '5 days left' | 'Race day is today' | 'Race day was 5 days ago'
export function raceCountdownText(todayISO, raceISO) {
  const c = raceCountdown(todayISO, raceISO);
  if (!c) return '';
  if (c.today) return 'Race day is today';
  if (c.past) return `Race day was ${plural(-c.days, 'day')} ago`;
  if (c.weeks === 0) return `${plural(c.days, 'day')} left`;
  return `${plural(c.weeks, 'week')}${c.extraDays ? ` and ${plural(c.extraDays, 'day')}` : ''} left`;
}

// Short headline for the Plan tab: '12 weeks to race day' | '5 days to race day' | 'Race day is today' | ''.
export function raceHeadline(todayISO, raceISO) {
  const c = raceCountdown(todayISO, raceISO);
  if (!c || c.past) return '';
  if (c.today) return 'Race day is today';
  return c.weeks === 0 ? `${plural(c.days, 'day')} to race day` : `${plural(c.weeks, 'week')} to race day`;
}

// Validation of the race date against the start date: the race must be after the start. -> error text | ''.
export function raceDateError(raceISO, startISO) {
  if (!raceISO) return '';
  if (!isValidISODate(raceISO)) return 'Enter a valid race date.';
  if (startISO && isValidISODate(startISO) && raceISO <= startISO) return 'The race date has to be after your start date.';
  return '';
}

// The start date that makes the plan's last week (the race week) contain the race date: the Monday TOTAL_WEEKS-1 weeks
// before the Monday of the race week.
export function idealStartForRace(raceISO, totalWeeks = TOTAL_WEEKS) {
  if (!isValidISODate(raceISO)) return null;
  return addDays(mondayOf(raceISO), -(totalWeeks - 1) * 7);
}

// How the plan's length fits between start and race day. Weeks are counted from the start date (7 days each).
// -> { diff, hint, idealStart } : diff > 0 = the race is later than the plan's last week (diff weeks of slack),
//    diff < 0 = the plan is longer than the time left; 0 = it fits. null without both dates.
export function raceAlignment(startISO, raceISO, totalWeeks = TOTAL_WEEKS) {
  if (!isValidISODate(startISO) || !isValidISODate(raceISO) || raceISO <= startISO) return null;
  const available = Math.ceil((daysBetween(startISO, raceISO) + 1) / 7); // weeks that touch start..race, inclusive
  const diff = available - totalWeeks;
  const idealStart = idealStartForRace(raceISO, totalWeeks);
  let hint;
  if (diff === 0) hint = `Your ${totalWeeks} plan weeks end right at race day.`;
  else if (diff > 0) hint = `There are ${plural(diff, 'week')} more than the ${totalWeeks} plan weeks before race day. Start later, or use the extra time to repeat a week.`;
  else hint = `The ${totalWeeks}-week plan is ${plural(-diff, 'week')} longer than the time to race day. Start earlier, or skip sessions.`;
  return { diff, hint, idealStart };
}

/* ---------- pauses ---------- */

const inclusiveDays = p => daysBetween(p.from, p.to) + 1;

// Error text for a pause being added ('' when fine): both dates, from first.
export function pauseError({ from, to } = {}) {
  if (!from || !to) return 'Pick both dates.';
  if (!isValidISODate(from) || !isValidISODate(to)) return 'Enter valid dates.';
  if (to < from) return 'The end date has to be on or after the start date.';
  return '';
}

// 'Pause my plan' quick action: today until `untilISO` (inclusive). -> { ok, pause } | { ok:false, error }
export function quickPause(todayISO, untilISO, note = '') {
  const error = pauseError({ from: todayISO, to: untilISO });
  if (error) return { ok: false, error: untilISO && untilISO < todayISO ? 'Pick a date from today on.' : error };
  const n = typeof note === 'string' ? note.trim() : '';
  return { ok: true, pause: n ? { from: todayISO, to: untilISO, note: n } : { from: todayISO, to: untilISO } };
}

const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
const dm = iso => `${Number(iso.slice(8, 10))} ${MONTHS[Number(iso.slice(5, 7)) - 1]}`;

// '12 Apr to 20 Apr' (the year only when the range crosses years or is not this year), plus the number of days.
export function pauseRangeText(p, todayISO) {
  if (!p || !isValidISODate(p.from) || !isValidISODate(p.to)) return '';
  const year = todayISO && isValidISODate(todayISO) ? todayISO.slice(0, 4) : null;
  const withYear = iso => (year && iso.slice(0, 4) === year ? dm(iso) : `${dm(iso)} ${iso.slice(0, 4)}`);
  const days = inclusiveDays(p);
  const range = p.from === p.to ? withYear(p.from) : `${withYear(p.from)} to ${withYear(p.to)}`;
  return `${range} · ${plural(days, 'day')}`;
}

// 'active' (today inside) | 'upcoming' | 'past'
export function pauseState(p, todayISO) {
  if (!p) return 'past';
  if (todayISO >= p.from && todayISO <= p.to) return 'active';
  return todayISO < p.from ? 'upcoming' : 'past';
}

// The pause that covers today, or null.
export const activePause = (pauses, todayISO) => (pauses || []).find(p => todayISO >= p.from && todayISO <= p.to) || null;

// Appends / removes one pause from the list (the store's planModel validation then sorts and merges ranges).
export const withPause = (pauses, pause) => [...(pauses || []), pause];
export const withoutPause = (pauses, index) => (pauses || []).filter((_, i) => i !== index);

/* ---------- skipped sessions ---------- */

// Skipped session id -> 'Week 7 · Speed'. Ids are a plan run id ('1-7-1-a'; '...~r2' = the repeat pass of a repeated week) or the
// alias 'w<week>-<runType>' (also with '~r2').
export function sessionLabel(id) {
  if (typeof id !== 'string') return '';
  const repeat = /~r2$/.test(id);
  const base = id.replace(/~r2$/, '');
  const suffix = repeat ? ' (repeat)' : '';
  const m = /^w(\d+)-([a-z]+)$/.exec(base);
  if (m) {
    const t = RUN_TYPE_BY_KEY[m[2]];
    return `Week ${Number(m[1])} · ${t ? t.name : m[2]}${suffix}`;
  }
  const hit = PLAN_RUN_BY_ID[base];
  return hit ? `Week ${hit.week} · ${hit.run.type}${suffix}` : id;
}

/* ---------- plan header ('12 weeks to race day · 31 sessions left') ---------- */

// Sessions the person still has to do. Flexible weeks carry the engine's own counts (sessionsTotal / sessionsDone); fixed weeks
// are estimated: the planned runs (with a distance) of every week that is not fulfilled, minus the runs logged in it.
export function sessionsLeft(weeks, person) {
  let left = 0;
  for (const w of weeks || []) {
    const wp = w && w[person];
    if (!wp || wp.status === 'n/a') continue;
    if (Number.isInteger(wp.sessionsTotal)) { left += Math.max(0, wp.sessionsTotal - (wp.sessionsDone || 0)); continue; }
    if (wp.status === 'fulfilled') continue;
    const planned = (wp.runs || []).filter(r => r.km > 0).length;
    const logged = (wp.entries || []).filter(e => e.sport === 'run' && e.km > 0).length;
    left += Math.max(0, planned - logged);
  }
  return left;
}

// Headline pieces joined with ' · ', skipping what is unknown.
export function planHeaderText({ todayISO, raceISO, sessions } = {}) {
  const parts = [];
  const race = raceISO ? raceHeadline(todayISO, raceISO) : '';
  if (race) parts.push(race);
  if (Number.isFinite(sessions)) parts.push(`${plural(sessions, 'session')} left`);
  return parts.join(' · ');
}
