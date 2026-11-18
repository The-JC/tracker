// Pure helpers for the daily run reminder (docs/REBUILD_PLAN.md §4 `settings/reminders/<a|b>`).
// Times are 'HH:MM' (24 h) in the person's own IANA time zone; everything is computed with Intl, no dependencies.
// Nothing here touches the DOM, so it is node-tested (tests/reminderTime.test.mjs).

export const DEFAULT_REMINDER_TIME = '07:30';
export const REMINDER_STEP_MIN = 5;

const TIME_RE = /^([01]\d|2[0-3]):([0-5]\d)$/;

// 'HH:MM', 00:00-23:59 (zero padded).
export const isValidTime = s => typeof s === 'string' && TIME_RE.test(s);

export function timeToMinutes(s) {
  const m = TIME_RE.exec(s);
  return m ? Number(m[1]) * 60 + Number(m[2]) : null;
}

export function minutesToTime(min) {
  const m = ((Math.round(min) % 1440) + 1440) % 1440;
  return `${String(Math.floor(m / 60)).padStart(2, '0')}:${String(m % 60).padStart(2, '0')}`;
}

// Rounds to the nearest 5 minutes ('07:32' -> '07:30', '07:33' -> '07:35'). The day does not wrap: '23:58' -> '23:55'.
// Returns null for anything that is not a valid 'HH:MM'.
export function roundTime(s, step = REMINDER_STEP_MIN) {
  const min = timeToMinutes(s);
  if (min == null) return null;
  const rounded = Math.min(Math.round(min / step) * step, Math.floor(1439 / step) * step);
  return minutesToTime(rounded);
}

export function isValidTimeZone(tz) {
  if (typeof tz !== 'string' || !tz) return false;
  try { new Intl.DateTimeFormat('en-US', { timeZone: tz }); return true; } catch (e) { return false; }
}

// The device's IANA zone ('' when the browser does not say).
export function deviceTimeZone() {
  try { return Intl.DateTimeFormat().resolvedOptions().timeZone || ''; } catch (e) { return ''; }
}

const formatters = new Map();
function formatterFor(tz) {
  let f = formatters.get(tz);
  if (!f) {
    f = new Intl.DateTimeFormat('en-CA', {
      timeZone: tz, hourCycle: 'h23', year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit'
    });
    formatters.set(tz, f);
  }
  return f;
}

// Wall-clock date and minutes since midnight of the instant `now` in `tz` -> { date: 'YYYY-MM-DD', minutes }.
// An unknown/empty zone falls back to the device zone.
export function zonedNow(tz, now = Date.now()) {
  const zone = isValidTimeZone(tz) ? tz : undefined;
  const f = zone ? formatterFor(zone) : new Intl.DateTimeFormat('en-CA', { hourCycle: 'h23', year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit' });
  const p = {};
  for (const part of f.formatToParts(new Date(now))) p[part.type] = part.value;
  return { date: `${p.year}-${p.month}-${p.day}`, minutes: (Number(p.hour) % 24) * 60 + Number(p.minute) };
}

export const todayInTz = (tz, now = Date.now()) => zonedNow(tz, now).date;

// True when `time` has already been reached today in `tz` (so a reminder saved now must not fire until tomorrow).
export function hasPassedToday(time, tz, now = Date.now()) {
  const t = timeToMinutes(time);
  return t != null && t <= zonedNow(tz, now).minutes;
}

// 'today' | 'tomorrow': when the next reminder fires. It is today if the time is still ahead and the server has not
// already sent today's one (`lastSentDate`).
export function nextReminderDay(time, tz, now = Date.now(), lastSentDate = null) {
  const here = zonedNow(tz, now);
  const t = timeToMinutes(time);
  if (t == null) return null;
  return t > here.minutes && lastSentDate !== here.date ? 'today' : 'tomorrow';
}

// Status line for Settings: 'Off' | 'Next reminder: today 07:30' | 'Next reminder: tomorrow 07:30'.
export function nextReminderText({ enabled, time, tz, lastSentDate = null } = {}, now = Date.now()) {
  if (!enabled || !isValidTime(time)) return 'Off';
  return `Next reminder: ${nextReminderDay(time, tz, now, lastSentDate)} ${time}`;
}

// Fields to write when saving: only enabled/time/tz/updatedTs, plus lastSentDate = today ONLY when an enabled reminder's
// time has already passed today in `tz` (enabling at 21:00 for 20:00 must not fire immediately). Never anything undefined.
export function buildReminderPatch({ enabled, time, tz }, now = Date.now()) {
  const patch = { enabled: !!enabled, time, tz, updatedTs: now };
  if (patch.enabled && hasPassedToday(time, tz, now)) patch.lastSentDate = todayInTz(tz, now);
  return patch;
}

// Database value -> a complete reminder object (defaults for anything missing or malformed).
export function normalizeReminder(v) {
  const r = v && typeof v === 'object' ? v : {};
  return {
    enabled: r.enabled === true,
    time: isValidTime(r.time) ? r.time : DEFAULT_REMINDER_TIME,
    tz: typeof r.tz === 'string' ? r.tz : '',
    lastSentDate: typeof r.lastSentDate === 'string' ? r.lastSentDate : null,
    updatedTs: Number.isFinite(r.updatedTs) ? r.updatedTs : 0
  };
}
