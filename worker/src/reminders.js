// Daily run reminders, driven by a Cron Trigger. Wakes every few minutes; for each person who enabled a reminder
// it decides (in THEIR time zone) whether it is time, claims the day, then sends today's recommended run as Web Push.
import { recommendForPerson, reminderMessage } from '../../src/recommendForPerson.js';
import { DB_ROOT, dbGet, dbPatch, loadSubs, loadVapidKey, sendToSubs } from './shared.js';

export const DEFAULT_TZ = 'Europe/Zurich';
// A reminder is sent at the configured time or up to this long after it (cron hiccups, Worker outage), never later.
export const WINDOW_MINUTES = 3 * 60;
const PEOPLE = ['a', 'b'];

/* ---------- time zones ---------- */

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

// A usable IANA zone, else DEFAULT_TZ.
export function resolveTz(tz) {
  if (typeof tz === 'string' && tz.trim() && tz.length <= 64) {
    try { formatterFor(tz.trim()); return tz.trim(); } catch { /* invalid: fall through */ }
  }
  return DEFAULT_TZ;
}

// Wall clock in `tz` at epoch ms `ms` -> { tz, date: 'YYYY-MM-DD', minutes: minutes since local midnight }.
// Reads the zone's own calendar through Intl, so DST changes need no special handling.
export function localParts(ms, tz) {
  const zone = resolveTz(tz);
  const p = {};
  for (const { type, value } of formatterFor(zone).formatToParts(new Date(ms))) p[type] = value;
  return { tz: zone, date: `${p.year}-${p.month}-${p.day}`, minutes: (Number(p.hour) % 24) * 60 + Number(p.minute) };
}

// 'HH:MM' (24 h) -> minutes since midnight, or null.
export function parseTime(t) {
  const m = /^([01]\d|2[0-3]):([0-5]\d)$/.exec(typeof t === 'string' ? t.trim() : '');
  return m ? Number(m[1]) * 60 + Number(m[2]) : null;
}

// Is this reminder due right now? -> { due, why, date (local today), tz }
// Due = enabled, local time >= configured time, less than WINDOW_MINUTES after it (same local day), not sent today yet.
export function dueCheck(cfg, nowMs) {
  const local = localParts(nowMs, cfg && cfg.tz);
  const out = (due, why) => ({ due, why, date: local.date, tz: local.tz });
  if (!cfg || typeof cfg !== 'object' || cfg.enabled !== true) return out(false, 'disabled');
  const at = parseTime(cfg.time);
  if (at === null) return out(false, 'bad-time');
  const late = local.minutes - at;
  if (late < 0) return out(false, 'too-early');
  if (late >= WINDOW_MINUTES) return out(false, 'window-over');
  if (cfg.lastSentDate === local.date) return out(false, 'already-sent');
  return out(true, 'due');
}

/* ---------- shared: the recommendation for one person from database contents ---------- */

const nameOf = (v, fallback) => {
  const n = typeof v === 'string' ? v.replace(/\s+/g, ' ').trim().slice(0, 40) : '';
  return n || fallback;
};
export const DEFAULT_NAMES = { a: 'Beatrix', b: 'Julian' };

// Reads log/goals/settings/plans/name with `auth` and builds the person's recommendation for `todayISO`.
// `plans/<a|b>` is the per-person plan state (own start date, ...); an absent or unreadable node means today's behaviour.
// -> { rec, name, loggedToday }
export async function recommendationFromDb({ fetchFn, env, auth, person, todayISO, settings }) {
  const [log, goals, st, planState, name] = await Promise.all([
    dbGet(fetchFn, env, `${DB_ROOT}/log`, auth),
    dbGet(fetchFn, env, `${DB_ROOT}/goals`, auth),
    settings ? Promise.resolve(settings) : dbGet(fetchFn, env, `${DB_ROOT}/settings`, auth),
    dbGet(fetchFn, env, `${DB_ROOT}/plans`, auth).catch(() => null),
    dbGet(fetchFn, env, `${DB_ROOT}/name${person.toUpperCase()}`, auth).catch(() => null)
  ]);
  const startDateSetting = st && typeof st.startDate === 'string' ? st.startDate : null;
  const { rec } = recommendForPerson({ person, log, goals, startDateSetting, planState, todayISO });
  const entries = log && typeof log === 'object' ? Object.values(log) : [];
  const loggedToday = entries.some(e => e && e.person === person && e.date === todayISO);
  return { rec, name: nameOf(name, DEFAULT_NAMES[person]), loggedToday };
}

/* ---------- the scheduled run ---------- */

async function processPerson({ person, cfg, fetchFn, env, now, auth, settings, log }) {
  const check = dueCheck(cfg, now());
  if (!check.due) return { person, status: 'not-due', why: check.why };

  const subs = await loadSubs(fetchFn, env, auth, person);
  if (!subs.length) return { person, status: 'no-subscription' };

  const { rec, name, loggedToday } = await recommendationFromDb({ fetchFn, env, auth, person, todayISO: check.date, settings });
  const claim = () => dbPatch(fetchFn, env, `${DB_ROOT}/settings/reminders/${person}`, auth, { lastSentDate: check.date });

  if (rec.kind !== 'run' || !rec.run) {
    await claim();
    log(`reminder ${person}: skipped (${rec.kind})`);
    return { person, status: 'skipped', why: rec.kind };
  }
  if (loggedToday) {
    await claim();
    log(`reminder ${person}: skipped (already logged today)`);
    return { person, status: 'skipped', why: 'logged-today' };
  }

  const privateKey = await loadVapidKey(env); // before claiming: a missing key must not burn the day
  await claim();                              // at-most-once: claimed BEFORE sending
  const r = await sendToSubs({ fetchFn, env, now, auth, subs, payload: reminderMessage(rec, name), privateKey });
  log(`reminder ${person}: sent=${r.sent} removed=${r.removed}`);
  return { person, status: 'sent', sent: r.sent, removed: r.removed };
}

// deps: { fetchFn, now, getToken|null, log?, state? }. Never throws. -> array of per-person results (for tests).
export async function runReminders(env, deps) {
  const { fetchFn, now, getToken } = deps;
  const log = deps.log || ((...a) => console.log(...a));
  const state = deps.state || runReminders.state;
  const results = [];
  try {
    if (!getToken) {
      if (!state.warned) { state.warned = true; log('reminders disabled: no service account'); }
      return results;
    }
    const auth = { bearer: await getToken() };
    const settings = await dbGet(fetchFn, env, `${DB_ROOT}/settings`, auth);
    const reminders = settings && typeof settings === 'object' && settings.reminders && typeof settings.reminders === 'object' ? settings.reminders : {};
    for (const person of PEOPLE) {
      if (!reminders[person] || reminders[person].enabled !== true) continue; // nothing to do, nothing to log
      try {
        results.push(await processPerson({ person, cfg: reminders[person], fetchFn, env, now, auth, settings, log }));
      } catch (e) {
        log(`reminder ${person}: error ${(e && e.message) || e}`);
        results.push({ person, status: 'error' });
      }
    }
  } catch (e) {
    try { log(`reminders: error ${(e && e.message) || e}`); } catch { /* never throw */ }
  }
  return results;
}
runReminders.state = { warned: false };
