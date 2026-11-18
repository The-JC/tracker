import test from 'node:test';
import assert from 'node:assert/strict';
import {
  relativeTime, shortDate, fulfilledCount, tileStatus, tilePct, tileLabel, detailAnchor, niceMax, chartModel,
  thisWeekSummary, splitEmoji, toastView, unseenNotes, badgeText
} from '../src/viewmodels.js';

const wk = (a, b, extra = {}) => ({ n: 1, kind: '', current: false, a: { status: a, pct: 50, plannedKm: 10, doneKm: 5 }, b: { status: b, pct: 50, plannedKm: 10, doneKm: 5 }, ...extra });

test('relativeTime', () => {
  const now = new Date(2026, 2, 10, 12, 0, 0).getTime();
  assert.equal(relativeTime(now - 20000, now), 'just now');
  assert.equal(relativeTime(now - 5 * 60000, now), '5 min ago');
  assert.equal(relativeTime(now - 3 * 3600000, now), '3 h ago');
  assert.equal(relativeTime(new Date(2026, 2, 9, 8, 0).getTime(), now), 'Yesterday');
  assert.equal(relativeTime(new Date(2026, 2, 5, 8, 0).getTime(), now), '5 Mar');
  assert.equal(relativeTime(0, now), '');
  assert.equal(relativeTime(now + 5000, now), 'just now', 'future clock skew');
});

test('shortDate', () => {
  assert.equal(shortDate('2026-03-02'), '2 Mar');
  assert.equal(shortDate(''), '');
});

test('tileStatus combines both people', () => {
  assert.deepEqual(tileStatus(wk('fulfilled', 'fulfilled')), { key: 'fulfilled', glyph: '✓' });
  assert.equal(tileStatus(wk('fulfilled', 'missed')).key, 'missed');
  assert.equal(tileStatus(wk('upcoming', 'upcoming')).key, 'upcoming');
  assert.equal(tileStatus(wk('current', 'fulfilled', { current: true })).glyph, '●');
  assert.equal(tileStatus(wk('fulfilled', 'fulfilled', { current: true })).glyph, '✓');
  assert.equal(tileStatus(wk('n/a', 'fulfilled')).key, 'fulfilled', 'n/a is ignored');
  assert.equal(tileStatus(wk('n/a', 'n/a')).key, 'upcoming');
});

test('tilePct / tileLabel / fulfilledCount', () => {
  assert.equal(tilePct({ pct: null, status: 'n/a' }), '–');
  assert.equal(tilePct({ pct: 0, status: 'upcoming' }), '–');
  assert.equal(tilePct({ pct: 0, status: 'missed' }), '0%');
  assert.equal(tilePct({ pct: 64, status: 'current' }), '64%');
  assert.equal(tileLabel({ kind: 'race-week' }), 'Race');
  assert.equal(tileLabel({ kind: '' }), 'Week');
  assert.equal(fulfilledCount([wk('fulfilled', 'missed'), wk('fulfilled', 'fulfilled')], 'a'), 2);
  assert.equal(fulfilledCount([wk('fulfilled', 'missed'), wk('fulfilled', 'fulfilled')], 'b'), 1);
});

test('detailAnchor: last tile of the open tile row', () => {
  assert.equal(detailAnchor(0, 3, 30), 2);
  assert.equal(detailAnchor(4, 3, 30), 5);
  assert.equal(detailAnchor(4, 4, 30), 7);
  assert.equal(detailAnchor(29, 4, 30), 29, 'clamped to the last tile');
  assert.equal(detailAnchor(28, 4, 30), 29);
  assert.equal(detailAnchor(null, 3, 30), -1);
});

test('niceMax and chartModel', () => {
  assert.equal(niceMax(0), 5);
  assert.equal(niceMax(12.4), 15);
  assert.equal(niceMax(1000), 1000);
  const a = [{ weekStart: '2026-03-02', km: 10 }, { weekStart: '2026-03-09', km: 0 }];
  const b = [{ weekStart: '2026-03-02', km: 5 }, { weekStart: '2026-03-09', km: 20 }];
  const m = chartModel(a, b);
  assert.equal(m.max, 20);
  assert.equal(m.groups.length, 2);
  assert.equal(m.groups[1].current, true);
  assert.equal(m.groups[1].b.h, m.base - m.ticks[2].y, 'max bar reaches the top gridline');
  assert.equal(m.groups[1].a.h, 0);
  assert.ok(m.groups[0].b.x > m.groups[0].a.x);
  assert.equal(m.hasData, true);
  assert.equal(chartModel([], []).hasData, false);
  assert.equal(m.groups[0].label, '2 Mar');
});

test('thisWeekSummary', () => {
  const weeks = [wk('fulfilled', 'fulfilled'), wk('current', 'upcoming', { current: true, n: 2 })];
  weeks[1].a.pct = 40; weeks[1].b.pct = 0;
  const stats = { a: { weeklyKm: [{ km: 1 }, { km: 8.5 }] }, b: { weeklyKm: [{ km: 3 }, { km: 5 }] } };
  const s = thisWeekSummary(weeks, stats);
  assert.equal(s.week.n, 2);
  assert.equal(s.people.a.km, 8.5);
  assert.equal(s.people.a.pct, 40);
  assert.equal(s.leader, 'a');
  assert.equal(s.lead, 3.5);
  const none = thisWeekSummary([wk('upcoming', 'upcoming')], { a: { weeklyKm: [{ km: 2 }] }, b: { weeklyKm: [{ km: 2 }] } });
  assert.equal(none.week, null);
  assert.equal(none.leader, null);
  assert.equal(none.people.a.pct, null);
});

test('splitEmoji / toastView', () => {
  assert.deepEqual(splitEmoji('Julian logged an 8.2 km run 🏃'), { text: 'Julian logged an 8.2 km run', emoji: '🏃' });
  assert.deepEqual(splitEmoji('plain text'), { text: 'plain text', emoji: '' });
  const t = toastView({ text: 'Julian completed week 3 🎉', kind: 'week', actor: 'b' });
  assert.equal(t.modifier, 'b');
  assert.equal(t.emoji, '🎉');
  assert.equal(t.text, 'Julian completed week 3');
  assert.equal(toastView({ text: 'Alerts enabled', kind: 'info' }).icon, 'i-info');
  assert.equal(toastView({ text: 'x', kind: 'info' }).modifier, '');
  assert.equal(toastView({ text: 'x', kind: 'danger' }).role, 'alert');
  assert.equal(toastView({ text: 'Beatrix posted a note: “hi”', kind: 'note', actor: 'a' }).emoji, '💬');
});

test('unseenNotes / badgeText', () => {
  const notes = [{ sender: 'a', ts: 10 }, { sender: 'b', ts: 20 }, { sender: 'b', ts: 5 }];
  assert.equal(unseenNotes(notes, 'a', 6), 1);
  assert.equal(unseenNotes(notes, 'a', 30), 0);
  assert.equal(unseenNotes(notes, null, 0), 0);
  assert.equal(badgeText(3), '3');
  assert.equal(badgeText(12), '9+');
});
