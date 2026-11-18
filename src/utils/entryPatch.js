// Pure logic for editing an existing activity (no Vue, no backend): turning the edit form into a minimal patch,
// validating it exactly like a new entry, and detecting that an edit made a plan week newly fulfilled.
// Used by store.updateActivity and LogActivitySheet (edit mode); node-tested in tests/entryPatch.test.mjs.
import { PLAN as DEFAULT_PLAN } from '../plan.js';
import {
  validateActivityInput, defaultTitle, buildWeeks, weekOfEntry, effectiveStartDate, isValidISODate
} from '../scoring.js';
import { weekEventText } from '../notifications.js';

// Fields a user may change. person, id, ts, kudos, imported are never part of a patch.
export const EDITABLE_FIELDS = ['sport', 'runType', 'title', 'date', 'km', 'durationMin', 'note'];
export const FUTURE_DATE_ERROR = 'That date is in the future. Pick today or earlier.';

const KM_SPORTS = new Set(['run', 'hike']);
const PLACEHOLDER_DATE = '2000-01-01'; // lets validateActivityInput run on an undated imported entry

/* ---------- form <-> entry ---------- */

// Form values (strings, as the create form holds them) for an existing entry. Undated imports get date ''.
export function formFromEntry(entry) {
  const e = entry || {};
  return {
    sport: e.sport || 'run',
    runType: e.runType || 'easy',
    date: e.date || '',
    km: e.km == null ? '' : String(e.km),
    durationMin: e.durationMin == null ? '' : String(e.durationMin),
    title: e.title || '',
    note: e.note || ''
  };
}

// True for the generated "Morning run" style titles of `sport` (any time of day).
export function isAutoTitle(title, sport) {
  const t = String(title || '').trim();
  if (!t) return true;
  return [0, 6, 13, 18, 22].some(h => defaultTitle(sport, new Date(2000, 0, 1, h)) === t);
}

// Form after the sport chip changed: fields that no longer apply are cleared (run type outside runs, distance outside
// run/hike, an auto-generated title of the old sport). Duration, date and note carry over.
export function changeSport(form, sport) {
  if (form.sport === sport) return form;
  const next = { ...form, sport };
  if (sport !== 'run') next.runType = 'easy';
  if (!KM_SPORTS.has(sport)) next.km = '';
  if (isAutoTitle(form.title, form.sport)) next.title = '';
  return next;
}

/* ---------- patch ---------- */

export function applyPatch(entry, patch) {
  const out = { ...entry };
  for (const [k, v] of Object.entries(patch)) {
    if (v === null) delete out[k]; else out[k] = v;
  }
  return out;
}

const normalized = (e, key) => (key === 'runType' && e.sport === 'run' && e[key] == null ? 'easy' : e[key]);

// Validates `input` (the create-form shape + optional photoDataUrl | removePhoto) against the existing `entry` and builds
// the minimal patch: only changed fields; `null` means "remove this field". Validation is identical to creating an
// entry (validateActivityInput) plus the "not in the future" rule; an undated imported entry may stay undated.
// -> { ok:false, error } | { ok:true, patch, next, photo:'keep'|'set'|'remove', changed }
//    `patch` already carries hasPhoto / week when they change; `editedTs` is added by the caller.
export function prepareEdit(entry, input, { today, now = new Date() } = {}) {
  const fail = error => ({ ok: false, error });
  if (!entry) return fail('That activity no longer exists.');
  const keepUndated = !entry.date && !(input && input.date);
  const checked = validateActivityInput(keepUndated ? { ...input, date: PLACEHOLDER_DATE } : input, now);
  if (!checked.ok) return checked;
  const value = { ...checked.value };
  if (keepUndated) delete value.date;
  else if (today && isValidISODate(value.date) && value.date > today) return fail(FUTURE_DATE_ERROR);

  const patch = {};
  for (const key of EDITABLE_FIELDS) {
    if (key === 'date' && keepUndated) continue;
    const next = value[key];
    const before = normalized(entry, key);
    if (next === undefined) { if (before !== undefined) patch[key] = null; }
    else if (next !== before) patch[key] = next;
  }
  // An imported entry with an explicit plan-week override follows its new real date instead.
  if (patch.date && entry.week != null) patch.week = null;

  let photo = 'keep';
  if (input && input.photoDataUrl) photo = 'set';
  else if (input && input.removePhoto && entry.hasPhoto) photo = 'remove';
  if (photo === 'set' && !entry.hasPhoto) patch.hasPhoto = true;
  if (photo === 'remove') patch.hasPhoto = false;

  return { ok: true, patch, next: applyPatch(entry, patch), photo, changed: Object.keys(patch).length > 0 || photo === 'set' };
}

/* ---------- plan week newly fulfilled by an edit ---------- */

// Plan week (number) of `next.person` that is fulfilled with the edit applied but was not before it, else null.
// Same before/after approach as addActivity. `log` is the current log (containing `entry`).
export function newlyFulfilledWeek({ entry, next, log, goals = {}, settingsStartDate = null, today, plan = DEFAULT_PLAN }) {
  if (!entry || !next || next.sport !== 'run' || !(next.km > 0)) return null;
  const person = next.person;
  const afterLog = (log || []).map(e => (e.id === entry.id ? next : e));
  const startAfter = effectiveStartDate(settingsStartDate, afterLog, today);
  const n = weekOfEntry(next, startAfter);
  if (!n || n < 1 || n > plan.length) return null;
  const done = (l, start) => buildWeeks(plan, goals, l, start, today)[n - 1][person].status === 'fulfilled';
  if (!done(afterLog, startAfter)) return null;
  const startBefore = effectiveStartDate(settingsStartDate, log || [], today);
  return done(log || [], startBefore) ? null : n;
}

// Is there already a 'week' event from `person` for plan week `n`? (Events only store their text.)
// Matched on the text minus the name, so a renamed person does not get a second event.
export function hasWeekEvent(events, person, n) {
  const tail = weekEventText('', n);
  return (events || []).some(ev => ev.kind === 'week' && ev.actor === person && String(ev.text || '').endsWith(tail));
}
