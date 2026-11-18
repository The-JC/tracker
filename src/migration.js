// One-time migration of the legacy (checkbox-era) data into `log` entries. Pure: no DOM, no Firebase.
//
// Legacy snapshot shape (trailhead-tracker-v1 root):
//   checks:     { '<runId>': true|false }
//   goals:      { '<runId>': '5.5' }                       plan-km overrides
//   activities: { a: [ {id, activity, minutes, ts} ], b: [...] }   (array shape), or
//               { 'activity-a-<ts>-<n>': { activity, value, checked, ts } }   (very old map shape)
//
// Produced entries have deterministic ids (`imp-…`) so re-running the migration overwrites instead of duplicating.
import { PLAN_RUN_BY_ID, LEGACY_SPORT_MAP, SPORT_BY_KEY } from './plan.js';
import { goalKm, toISODate } from './scoring.js';

const LEGACY_ACTIVITIES = new Set(Object.keys(LEGACY_SPORT_MAP));

// Firebase keys may not contain . # $ [ ] /
const safeKey = s => String(s).replace(/[.#$[\]/]/g, '_');

const asArrayLike = v => {
  if (Array.isArray(v)) return v;
  if (v && typeof v === 'object' && Object.keys(v).length && Object.keys(v).every(k => /^\d+$/.test(k))) {
    return Object.keys(v).sort((x, y) => x - y).map(k => v[k]); // sparse array returned as object
  }
  return null;
};

// Normalises one person's legacy activities to [{ id, activity, amount, ts }] (see old migrateActivities()).
function legacyActivities(raw, person) {
  if (!raw) return [];
  const list = asArrayLike(raw);
  if (list) {
    return list.filter(Boolean).map((e, i) => ({
      id: e.id || `${person}-${i}`,
      activity: LEGACY_ACTIVITIES.has(e.activity) ? e.activity : 'hiking',
      amount: parseFloat(e.minutes || e.value) || 0,
      ts: e.ts
    }));
  }
  if (typeof raw !== 'object') return [];
  return Object.entries(raw)
    .filter(([id, e]) => id.indexOf(`activity-${person}-`) === 0 && e && (e.checked || e.value))
    .map(([id, e]) => ({
      id,
      activity: LEGACY_ACTIVITIES.has(e.activity) ? e.activity : id.split('-').pop(),
      amount: parseFloat(e.value) || 0,
      ts: e.ts
    }))
    .filter(e => LEGACY_ACTIVITIES.has(e.activity));
}

// -> ActivityEntry[] (each with `id`), see REBUILD_PLAN §4. Checked runs without a distance (km <= 0) are skipped.
export function migrateLegacy(v1, plan, now = Date.now()) {
  const entries = [];
  v1 = v1 || {};
  // lookup from the plan that was passed in (defaults to the real one)
  const lookup = {};
  if (plan) {
    for (const w of plan) for (const p of ['a', 'b']) for (const r of w.runs[p]) lookup[r.id] = { run: r, week: w.n, person: p };
  } else Object.assign(lookup, PLAN_RUN_BY_ID);

  for (const [runId, checked] of Object.entries(v1.checks || {})) {
    if (checked !== true) continue;
    const hit = lookup[runId];
    if (!hit) continue;
    const km = goalKm(hit.run, v1.goals);
    if (!(km > 0)) continue;
    entries.push({
      id: `imp-${safeKey(runId)}`, person: hit.person, sport: 'run', runType: hit.run.runType,
      title: `Week ${hit.week} · ${hit.run.type}`, date: null, km, week: hit.week,
      hasPhoto: false, imported: true, ts: now
    });
  }

  const used = new Set();
  for (const person of ['a', 'b']) {
    for (const act of legacyActivities(v1.activities && v1.activities[person], person)) {
      if (!(act.amount > 0)) continue;
      const sport = LEGACY_SPORT_MAP[act.activity];
      const def = SPORT_BY_KEY[sport];
      const ts = Number(act.ts) > 0 ? Number(act.ts) : now;
      let id = `imp-act-${person}-${safeKey(act.id)}`;
      while (used.has(id)) id += '_';
      used.add(id);
      const e = { id, person, sport, title: def.label, date: toISODate(ts), hasPhoto: false, imported: true, ts };
      if (def.requires === 'km') e.km = act.amount; else e.durationMin = act.amount;
      entries.push(e);
    }
  }
  return entries;
}
