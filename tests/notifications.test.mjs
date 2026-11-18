import test from 'node:test';
import assert from 'node:assert/strict';
import {
  describeEntry, activityEventText, weekEventText, kudosEventText, noteEventText, unreadEvents, freshEvents,
  nextLastRead, documentTitle, toastFor, shouldShowSystemNotification, BASE_TITLE
} from '../src/notifications.js';

const ev = (id, actor, ts, o = {}) => ({ id, actor, kind: 'activity', text: `${id} text`, ts, ...o });

test('event texts', () => {
  assert.equal(activityEventText('Julian', { sport: 'run', km: 8.2 }), 'Julian logged an 8.2 km run');
  assert.equal(activityEventText('Julian', { sport: 'run', km: 10 }), 'Julian logged a 10 km run');
  assert.equal(activityEventText('Beatrix', { sport: 'swim', durationMin: 45 }), 'Beatrix logged a 45 min swim');
  assert.equal(activityEventText('Beatrix', { sport: 'hike', km: 12.5 }), 'Beatrix logged a 12.5 km hike');
  assert.equal(describeEntry({ sport: 'cycle', durationMin: 90 }), '90 min ride');
  assert.equal(weekEventText('Julian', 7), 'Julian completed week 7 🎉');
  assert.equal(kudosEventText('Julian', { title: 'Morning run' }), 'Julian gave kudos to your Morning run');
  assert.equal(noteEventText('Julian', '  hello\n world '), 'Julian posted a note: “hello world”');
  assert.ok(noteEventText('J', 'x'.repeat(100)).includes('…'));
  assert.equal(noteEventText('J', ''), 'J posted a photo note');
});

test('unreadEvents: only the other person, only newer than lastReadTs', () => {
  const events = [ev('3', 'b', 300), ev('2', 'a', 250), ev('1', 'b', 100)];
  assert.deepEqual(unreadEvents(events, 'a', 150).map(e => e.id), ['3']);
  assert.deepEqual(unreadEvents(events, 'b', 150).map(e => e.id), ['2']);
  assert.deepEqual(unreadEvents(events, 'a', 0).map(e => e.id), ['3', '1']);
  assert.deepEqual(unreadEvents(events, null, 0), []);
  assert.deepEqual(unreadEvents(undefined, 'a', 0), []);
});

test('freshEvents: first snapshot is a baseline; later ones yield only new foreign events', () => {
  const first = [ev('1', 'b', 100), ev('2', 'a', 110)];
  assert.deepEqual(freshEvents(first, 'a', null), [], 'baseline');
  const known = new Set(first.map(e => e.id));
  const second = [ev('4', 'a', 400), ev('3', 'b', 300), ...first];
  assert.deepEqual(freshEvents(second, 'a', known).map(e => e.id), ['3']);
  assert.deepEqual(freshEvents(second, null, known), []);
  // clock skew: an event with an old timestamp is still fresh because ids are what count
  assert.deepEqual(freshEvents([ev('9', 'b', 1), ...first], 'a', known).map(e => e.id), ['9']);
});

test('freshEvents: an old event sliding into the limitToLast window is not new', () => {
  const known = new Set(['5', '6', '7']);
  // '3' by the other person was outside the window; deleting '7' pulled it in. '8' is genuinely new.
  assert.deepEqual(freshEvents([ev('8', 'b', 800), ev('6', 'a', 600), ev('5', 'b', 500), ev('3', 'b', 300)], 'a', known).map(e => e.id), ['8']);
});

test('nextLastRead never trails the newest event', () => {
  assert.equal(nextLastRead([ev('1', 'b', 5000)], 1000), 5000);
  assert.equal(nextLastRead([ev('1', 'b', 500)], 1000), 1000);
  assert.equal(nextLastRead([], 42), 42);
});

test('documentTitle', () => {
  assert.equal(documentTitle(0), BASE_TITLE);
  assert.equal(documentTitle(3), `(3) ${BASE_TITLE}`);
  assert.ok(BASE_TITLE.startsWith('Trailhead'));
});

test('toastFor adds an emoji by kind / sport', () => {
  const log = [{ id: 'x', sport: 'swim' }];
  assert.equal(toastFor(ev('1', 'b', 1, { refId: 'x', text: 'J logged a 45 min swim' }), log).text, 'J logged a 45 min swim 🏊');
  assert.equal(toastFor(ev('1', 'b', 1, { kind: 'kudos', text: 'K' }), log).text, 'K 👏');
  assert.equal(toastFor(ev('1', 'b', 1, { kind: 'week', text: 'W 🎉' }), log).text, 'W 🎉');
  assert.equal(toastFor(ev('1', 'b', 1, { kind: 'week', text: 'W' }), log).kind, 'week');
});

test('system notifications only when permitted and the page is hidden', () => {
  assert.equal(shouldShowSystemNotification({ permission: 'granted', hidden: true }), true);
  assert.equal(shouldShowSystemNotification({ permission: 'granted', hidden: false }), false);
  assert.equal(shouldShowSystemNotification({ permission: 'default', hidden: true }), false);
  assert.equal(shouldShowSystemNotification({ permission: 'denied', hidden: true }), false);
});
