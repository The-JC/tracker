// Pure view-model helpers of the Plan tab that depend on each person's plan mode (fixed weeks vs flexible). No Vue, no DOM.
// A flexible ('rolling') plan never "misses" a week: the person is only behind by some sessions.
import { tileStatus } from '../viewmodels.js';

export const isFlexible = state => !!state && state.mode === 'rolling';

// Tile status of a week from both people's statuses, where a person in flexible mode can never make a tile "missed".
// `modes` = { a: 'calendar'|'rolling', b: ... }. A flexible person's 'missed' counts as not finished yet ('upcoming').
export function tileStatusFor(week, modes = {}) {
  const adjusted = { ...week };
  for (const p of ['a', 'b']) {
    if (modes[p] === 'rolling' && week[p] && week[p].status === 'missed') adjusted[p] = { ...week[p], status: 'upcoming' };
  }
  return tileStatus(adjusted);
}

// 'behind by 2 sessions' | 'behind by 1 session' | '' (nothing to show)
export function behindText(n) {
  return Number.isInteger(n) && n > 0 ? `behind by ${n} ${n === 1 ? 'session' : 'sessions'}` : '';
}

// Status words of one person's week for the detail panel. In flexible mode 'missed' never appears. The engine's
// `behindSessions` is the person's TOTAL (the same number on every week), so it is only spelled out on the current week.
export function weekStatusText(wp, mode) {
  if (!wp) return '';
  if (wp.status === 'n/a') return 'nothing planned';
  if (mode === 'rolling') {
    if (wp.status === 'missed') return 'not finished';
    if (wp.status === 'current') return behindText(wp.behindSessions) || wp.status;
  }
  return wp.status;
}

// Sessions a flexible person is behind pace in total (the engine puts the same number on every week; 0 when absent).
export function totalBehind(weeks, person) {
  let n = 0;
  for (const w of weeks || []) {
    const v = w && w[person] && w[person].behindSessions;
    if (Number.isInteger(v) && v > n) n = v;
  }
  return n;
}

/* ---------- one-time "try the flexible plan" banner (per device) ---------- */

export const FLEX_BANNER_KEY = 'trailhead-flex-banner-dismissed';

// Shown to people still in fixed-week mode until they dismiss it on this device. `storage` is localStorage (or a stub).
export function shouldShowFlexBanner(state, storage) {
  if (!state || state.mode !== 'calendar') return false;
  try { return !(storage && storage.getItem(FLEX_BANNER_KEY)); } catch (e) { return true; }
}
export function dismissFlexBanner(storage) {
  try { if (storage) storage.setItem(FLEX_BANNER_KEY, '1'); } catch (e) { /* private mode: it just shows again next time */ }
}
