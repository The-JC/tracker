import test from 'node:test';
import assert from 'node:assert/strict';
import {
  isFlexible, tileStatusFor, behindText, weekStatusText, totalBehind,
  FLEX_BANNER_KEY, shouldShowFlexBanner, dismissFlexBanner
} from '../src/utils/planViewModel.js';

const wk = (a, b, current = false) => ({ n: 3, current, a: { status: a, pct: 10 }, b: { status: b, pct: 10 } });

test('tileStatusFor: a flexible person never makes a tile missed', () => {
  assert.equal(tileStatusFor(wk('missed', 'fulfilled'), { a: 'calendar', b: 'calendar' }).key, 'missed');
  assert.equal(tileStatusFor(wk('missed', 'fulfilled'), { a: 'rolling', b: 'calendar' }).key, 'upcoming');
  assert.equal(tileStatusFor(wk('fulfilled', 'missed'), { a: 'rolling', b: 'calendar' }).key, 'missed'); // b's own plan is fixed
  assert.equal(tileStatusFor(wk('missed', 'missed'), { a: 'rolling', b: 'rolling' }).key, 'upcoming');
  assert.equal(tileStatusFor(wk('fulfilled', 'fulfilled'), { a: 'rolling', b: 'rolling' }).key, 'fulfilled');
  assert.equal(tileStatusFor(wk('missed', 'upcoming', true), { a: 'rolling' }).key, 'current');
  assert.equal(tileStatusFor(wk('missed', 'fulfilled')).key, 'missed'); // no modes = today's behaviour
});

test('tileStatusFor does not mutate the week', () => {
  const w = wk('missed', 'fulfilled');
  tileStatusFor(w, { a: 'rolling' });
  assert.equal(w.a.status, 'missed');
});

test('behind texts', () => {
  assert.equal(behindText(2), 'behind by 2 sessions');
  assert.equal(behindText(1), 'behind by 1 session');
  assert.equal(behindText(0), '');
  assert.equal(behindText(undefined), '');
  assert.equal(behindText(1.5), '');
});

test('weekStatusText: flexible mode says behind on the current week, never missed', () => {
  assert.equal(weekStatusText({ status: 'current', behindSessions: 2 }, 'rolling'), 'behind by 2 sessions');
  assert.equal(weekStatusText({ status: 'current', behindSessions: 0 }, 'rolling'), 'current');
  assert.equal(weekStatusText({ status: 'upcoming', behindSessions: 2 }, 'rolling'), 'upcoming');
  assert.equal(weekStatusText({ status: 'fulfilled', behindSessions: 2 }, 'rolling'), 'fulfilled');
  assert.equal(weekStatusText({ status: 'missed' }, 'rolling'), 'not finished');
  assert.equal(weekStatusText({ status: 'missed', behindSessions: 2 }, 'calendar'), 'missed');
  assert.equal(weekStatusText({ status: 'n/a' }, 'rolling'), 'nothing planned');
  assert.equal(weekStatusText(null, 'calendar'), '');
});

test('totalBehind reads the engine total', () => {
  const weeks = [{ a: { behindSessions: 2 } }, { a: { behindSessions: 2 } }, { a: {} }, {}];
  assert.equal(totalBehind(weeks, 'a'), 2);
  assert.equal(totalBehind(undefined, 'a'), 0);
});

test('isFlexible reads the stored mode', () => {
  assert.equal(isFlexible({ mode: 'rolling' }), true);
  assert.equal(isFlexible({ mode: 'calendar' }), false);
  assert.equal(isFlexible(null), false);
});

test('flexible-plan banner: calendar mode only, until dismissed on this device', () => {
  const mem = () => { const m = {}; return { getItem: k => (k in m ? m[k] : null), setItem: (k, v) => { m[k] = String(v); } }; };
  const s = mem();
  assert.equal(shouldShowFlexBanner({ mode: 'calendar' }, s), true);
  assert.equal(shouldShowFlexBanner({ mode: 'rolling' }, s), false);
  assert.equal(shouldShowFlexBanner(null, s), false);
  dismissFlexBanner(s);
  assert.equal(s.getItem(FLEX_BANNER_KEY), '1');
  assert.equal(shouldShowFlexBanner({ mode: 'calendar' }, s), false);
  // broken storage: shows (cannot know), never throws
  const broken = { getItem() { throw new Error('denied'); }, setItem() { throw new Error('denied'); } };
  assert.equal(shouldShowFlexBanner({ mode: 'calendar' }, broken), true);
  assert.doesNotThrow(() => dismissFlexBanner(broken));
  assert.equal(shouldShowFlexBanner({ mode: 'calendar' }, undefined), true);
});
