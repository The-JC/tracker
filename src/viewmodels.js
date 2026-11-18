// Pure view-model helpers for the shell, plan, stats and notification views (no Vue, no DOM; node-tested).
import { daysBetween } from './scoring.js';

const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];

/* ---------- time ---------- */

// 'just now' | '5 min ago' | '3 h ago' | 'Yesterday' | '12 Mar' for an epoch-ms timestamp.
export function relativeTime(ts, now = Date.now()) {
  const t = Number(ts);
  if (!Number.isFinite(t) || t <= 0) return '';
  const diff = Math.max(0, now - t);
  const min = Math.floor(diff / 60000);
  if (min < 1) return 'just now';
  if (min < 60) return `${min} min ago`;
  const h = Math.floor(min / 60);
  if (h < 24) return `${h} h ago`;
  const d = new Date(t), n = new Date(now);
  const dayDiff = daysBetween(
    `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`,
    `${n.getFullYear()}-${String(n.getMonth() + 1).padStart(2, '0')}-${String(n.getDate()).padStart(2, '0')}`
  );
  if (dayDiff <= 1) return 'Yesterday';
  return `${d.getDate()} ${MONTHS[d.getMonth()]}`;
}

// '2026-03-02' -> '2 Mar'
export function shortDate(iso) {
  if (typeof iso !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(iso)) return '';
  const [, m, d] = iso.split('-').map(Number);
  return `${d} ${MONTHS[m - 1]}`;
}

/* ---------- plan overview ---------- */

export const PERSONS = ['a', 'b'];

// Number of weeks a person has fulfilled.
export const fulfilledCount = (weeks, p) => (weeks || []).filter(w => w[p].status === 'fulfilled').length;

export const currentWeek = weeks => (weeks || []).find(w => w.current) || null;

// One status per tile from both people: { key: 'fulfilled'|'current'|'missed'|'upcoming', glyph }.
// current week always reads as current (glyph becomes a check once both are fulfilled);
// a finished week is missed as soon as either person missed it; a future week is upcoming.
export function tileStatus(week) {
  const sts = PERSONS.map(p => week[p].status).filter(s => s !== 'n/a');
  const allDone = sts.length > 0 && sts.every(s => s === 'fulfilled');
  if (week.current) return { key: 'current', glyph: allDone ? '✓' : '●' };
  if (sts.includes('missed')) return { key: 'missed', glyph: '!' };
  if (allDone) return { key: 'fulfilled', glyph: '✓' };
  return { key: 'upcoming', glyph: '·' };
}

// Percentage text of a tile: '64%' or '–' when nothing is known yet.
export function tilePct(person) {
  if (person.pct == null) return '–';
  if (person.status === 'upcoming' && person.pct === 0) return '–';
  return `${person.pct}%`;
}

export const tileLabel = week => (week.kind === 'cutback' ? 'Cutback' : week.kind === 'peak' ? 'Peak' : week.kind === 'race-week' ? 'Race' : 'Week');

// Index of the grid item after which the expanded detail row is inserted: the last tile of the open tile's row.
export function detailAnchor(openIndex, cols, total) {
  if (openIndex == null || openIndex < 0 || cols < 1) return -1;
  return Math.min(Math.floor(openIndex / cols) * cols + cols - 1, total - 1);
}

/* ---------- stats chart ---------- */

// Rounds a maximum up to a pleasant axis top (at least 5).
export function niceMax(max) {
  if (!(max > 0)) return 5;
  const steps = [5, 10, 15, 20, 25, 30, 40, 50, 60, 80, 100, 120, 150, 200, 250, 300, 400, 500];
  for (const s of steps) if (max <= s) return s;
  return Math.ceil(max / 100) * 100;
}

// Grouped bar chart geometry in a width x height viewBox.
// weeklyA / weeklyB: [{ weekStart, km }] oldest first (same length). -> { width, height, base, max, ticks, groups, hasData }
export function chartModel(weeklyA, weeklyB, { width = 320, height = 150, left = 30, top = 14, bottom = 26, barW = 14, gap = 2 } = {}) {
  const n = Math.max((weeklyA || []).length, (weeklyB || []).length);
  const plotH = height - top - bottom;
  const base = top + plotH;
  const peak = Math.max(0, ...(weeklyA || []).map(w => w.km), ...(weeklyB || []).map(w => w.km));
  const max = niceMax(peak);
  const slot = n ? (width - left) / n : 0;
  const barsW = barW * 2 + gap;
  const y = km => base - (Math.max(0, km) / max) * plotH;
  const groups = Array.from({ length: n }, (_, i) => {
    const wa = weeklyA[i] || { weekStart: '', km: 0 };
    const wb = weeklyB[i] || { weekStart: wa.weekStart, km: 0 };
    const x0 = left + i * slot + (slot - barsW) / 2;
    const bar = (w, x) => ({ x: round1(x), y: round1(y(w.km)), w: barW, h: round1(base - y(w.km)), km: w.km });
    return { weekStart: wa.weekStart || wb.weekStart, label: shortDate(wa.weekStart || wb.weekStart), current: i === n - 1, cx: round1(left + i * slot + slot / 2), a: bar(wa, x0), b: bar(wb, x0 + barW + gap) };
  });
  const ticks = [0, 0.5, 1].map(f => ({ value: Math.round(max * f * 10) / 10, y: round1(y(max * f)) }));
  return { width, height, base, max, ticks, groups, hasData: peak > 0 };
}

const round1 = v => Math.round(v * 10) / 10;

/* ---------- this week head-to-head ---------- */

// km logged this week per person (Monday-based series from stats) + the plan-week percent.
// -> { week: Week|null, people: { a: { km, pct|null, planned }, b: {...} }, leader: 'a'|'b'|null, lead: number }
export function thisWeekSummary(weeks, stats) {
  const week = currentWeek(weeks);
  const people = {};
  for (const p of PERSONS) {
    const series = (stats && stats[p] && stats[p].weeklyKm) || [];
    const last = series.length ? series[series.length - 1].km : 0;
    people[p] = { km: last, pct: week ? week[p].pct : null, planned: week ? week[p].plannedKm : 0, done: week ? week[p].doneKm : 0 };
  }
  const diff = Math.round((people.a.km - people.b.km) * 1000) / 1000;
  return { week, people, leader: diff > 0 ? 'a' : diff < 0 ? 'b' : null, lead: Math.abs(diff) };
}

/* ---------- notifications / toasts / notes ---------- */

// Trailing emoji of an event text ("… run 🏃" -> '🏃'), and the text without it.
const TRAILING_EMOJI = /\s*(\p{Extended_Pictographic}(?:️|‍\p{Extended_Pictographic})*)\s*$/u;
export function splitEmoji(text) {
  const s = String(text || '');
  const m = s.match(TRAILING_EMOJI);
  return m ? { text: s.slice(0, m.index).trimEnd(), emoji: m[1] } : { text: s, emoji: '' };
}

const KIND_EMOJI = { activity: '🏃', kudos: '👏', week: '🎉', note: '💬' };
const KIND_ICON = { success: 'i-check', warning: 'i-alert', danger: 'i-alert', info: 'i-info' };
const KIND_LABEL = { activity: 'Activity', kudos: 'Kudos', week: 'Week completed', note: 'Note' };
export const kindLabel = kind => KIND_LABEL[kind] || '';

// Everything ToastHost needs: { text, emoji, icon, modifier, role }.
// Event kinds with an actor are coloured by person (--a/--b); status kinds map to their own modifier.
export function toastView(toast) {
  const kind = toast.kind || 'info';
  const { text, emoji } = splitEmoji(toast.text);
  const eventKind = kind in KIND_EMOJI;
  const modifier = toast.actor === 'a' || toast.actor === 'b' ? toast.actor : (kind === 'success' || kind === 'warning' || kind === 'danger') ? kind : '';
  return {
    text: eventKind ? text : toast.text,
    emoji: eventKind ? emoji || KIND_EMOJI[kind] : '',
    icon: eventKind ? '' : KIND_ICON[kind] || 'i-info',
    modifier,
    role: kind === 'danger' ? 'alert' : 'status'
  };
}

// Notes by the other person newer than the last time the Notes tab was viewed.
export const unseenNotes = (notes, me, seenTs) => (me ? (notes || []).filter(n => n.sender !== me && (n.ts || 0) > seenTs).length : 0);

export const badgeText = n => (n > 9 ? '9+' : String(n));
