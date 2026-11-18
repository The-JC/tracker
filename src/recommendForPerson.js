// One pipeline for "what should this person run today?", shared by the app's Next-up card and the
// Cloudflare Worker that sends the daily reminder, so the two can never diverge.
// Pure: no Vue, no DOM, no Firebase, no clock (today is passed in). Importable from the app and the Worker bundle.
import { PLAN } from './plan.js';
import { buildWeeks, effectiveStartDate, sortLog } from './scoring.js';
import { recommendNext } from './recommend.js';

// The `log` node of the database is an object keyed by entry id; the app keeps an array sorted newest first.
// Accepts either form and returns the sorted array the app uses.
export function logToEntries(log) {
  const list = Array.isArray(log)
    ? log
    : log && typeof log === 'object' ? Object.entries(log).map(([key, v]) => (v && typeof v === 'object' ? { ...v, id: v.id || key } : null)) : [];
  return sortLog(list.filter(e => e && typeof e === 'object'));
}

// -> { rec, weeks }: rec = recommendNext(...) result, weeks = buildWeeks(...) output (30 weeks).
//  * person: 'a' | 'b'
//  * log: array of entries, or the database `log` object
//  * goals: the `goals` node ({ [runId]: km string }), startDateSetting: settings/startDate or null
//  * todayISO: the person's local calendar date 'YYYY-MM-DD'
export function recommendForPerson({ person, log, goals, startDateSetting, todayISO }) {
  const entries = logToEntries(log);
  const g = goals && typeof goals === 'object' ? goals : {};
  const startDate = effectiveStartDate(startDateSetting, entries, todayISO);
  const weeks = buildWeeks(PLAN, g, entries, startDate, todayISO);
  const rec = recommendNext({ weeks, person, log: entries, goals: g, todayISO, startDate });
  return { rec, weeks };
}

/* ---------- push message ---------- */

export const REMINDER_TAG = 'trailhead-reminder';
export const REMINDER_URL = '/#/feed';
const MAX_BODY = 140;

const trim = (s, n) => {
  const t = String(s || '').replace(/\s+/g, ' ').trim();
  return t.length > n ? t.slice(0, n - 1).trimEnd() + '…' : t;
};
const km = x => (Math.round(x * 10) / 10).toString();

// -> { title, body, tag, url }. A run gets 'Today: Tempo 5 km' (the reminder itself). Every other
// kind only ever reaches a device through the "send test reminder" button and is prefixed 'Test: '.
export function reminderMessage(rec, name) {
  const base = { tag: REMINDER_TAG, url: REMINDER_URL };
  if (!rec) return { title: 'Test: no recommendation', body: '', ...base };
  if (rec.kind === 'run' && rec.run) {
    const r = rec.run;
    const title = r.km > 0 ? `Today: ${r.type} ${km(r.km)} km` : `Today: ${r.type}`;
    const body = trim(rec.reason, MAX_BODY) || (name ? `${name}, time for your run.` : 'Time for your run.');
    return { title, body, ...base };
  }
  const heads = {
    rest: rec.run ? `Rest day, next up ${rec.run.type}${rec.run.km > 0 ? ` ${km(rec.run.km)} km` : ''}` : 'Rest day',
    ahead: 'Ahead of plan',
    'not-started': 'Plan not started',
    done: rec.tags && rec.tags.includes('Plan complete') ? 'Plan complete' : (rec.weekNumber ? `Week ${rec.weekNumber} done` : 'Week done')
  };
  return { title: `Test: ${heads[rec.kind] || 'No run today'}`, body: trim(rec.reason, MAX_BODY), ...base };
}
