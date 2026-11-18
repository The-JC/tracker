import test from 'node:test';
import assert from 'node:assert/strict';
import {
  isValidTime, timeToMinutes, minutesToTime, roundTime, isValidTimeZone, zonedNow, todayInTz, hasPassedToday,
  nextReminderDay, nextReminderText, buildReminderPatch, normalizeReminder, DEFAULT_REMINDER_TIME
} from '../src/utils/reminderTime.js';

const at = iso => Date.parse(iso);

test('isValidTime accepts only zero-padded 24h HH:MM', () => {
  for (const ok of ['00:00', '07:30', '12:05', '23:59']) assert.equal(isValidTime(ok), true, ok);
  for (const bad of ['24:00', '7:30', '07:60', '07:3', '0730', '07:30:00', '', null, undefined, 730, '-1:00', '07:30 ']) assert.equal(isValidTime(bad), false, String(bad));
});

test('timeToMinutes / minutesToTime round trip and wrap', () => {
  assert.equal(timeToMinutes('00:00'), 0);
  assert.equal(timeToMinutes('07:30'), 450);
  assert.equal(timeToMinutes('23:59'), 1439);
  assert.equal(timeToMinutes('nope'), null);
  assert.equal(minutesToTime(450), '07:30');
  assert.equal(minutesToTime(1440), '00:00');
  assert.equal(minutesToTime(-5), '23:55');
});

test('roundTime rounds to the nearest 5 minutes and never wraps past the day', () => {
  assert.equal(roundTime('07:30'), '07:30');
  assert.equal(roundTime('07:32'), '07:30');
  assert.equal(roundTime('07:33'), '07:35');
  assert.equal(roundTime('07:58'), '08:00');
  assert.equal(roundTime('00:02'), '00:00');
  assert.equal(roundTime('23:58'), '23:55');
  assert.equal(roundTime('23:59'), '23:55');
  assert.equal(roundTime('25:00'), null);
  assert.equal(roundTime(''), null);
  assert.equal(roundTime('07:32', 15), '07:30');
});

test('isValidTimeZone', () => {
  assert.equal(isValidTimeZone('Europe/Zurich'), true);
  assert.equal(isValidTimeZone('UTC'), true);
  assert.equal(isValidTimeZone('Mars/Olympus'), false);
  assert.equal(isValidTimeZone(''), false);
  assert.equal(isValidTimeZone(null), false);
});

test('zonedNow gives the wall clock in a non-local time zone (date can differ from UTC)', () => {
  const t = at('2026-06-15T23:30:00Z');
  assert.deepEqual(zonedNow('UTC', t), { date: '2026-06-15', minutes: 23 * 60 + 30 });
  assert.deepEqual(zonedNow('Pacific/Auckland', t), { date: '2026-06-16', minutes: 11 * 60 + 30 }); // UTC+12
  assert.deepEqual(zonedNow('Asia/Kolkata', at('2026-06-15T20:00:00Z')), { date: '2026-06-16', minutes: 90 }); // UTC+5:30
  assert.deepEqual(zonedNow('America/Los_Angeles', at('2026-06-15T05:00:00Z')), { date: '2026-06-14', minutes: 22 * 60 }); // UTC-7
  assert.equal(todayInTz('Asia/Tokyo', at('2026-12-31T15:00:00Z')), '2027-01-01');
});

test('midnight is 00:00 (never 24:00)', () => {
  assert.deepEqual(zonedNow('UTC', at('2026-06-15T00:00:00Z')), { date: '2026-06-15', minutes: 0 });
  assert.deepEqual(zonedNow('Europe/Zurich', at('2026-06-14T22:00:00Z')), { date: '2026-06-15', minutes: 0 });
});

test('hasPassedToday uses the person time zone, not the device or UTC', () => {
  const t = at('2026-06-15T05:00:00Z'); // 07:00 Zurich (CEST), 22:00 the day before in Los Angeles
  assert.equal(hasPassedToday('07:30', 'Europe/Zurich', t), false);
  assert.equal(hasPassedToday('06:55', 'Europe/Zurich', t), true);
  assert.equal(hasPassedToday('07:00', 'Europe/Zurich', t), true, 'exactly now counts as passed');
  assert.equal(hasPassedToday('21:00', 'America/Los_Angeles', t), true);
  assert.equal(hasPassedToday('22:30', 'America/Los_Angeles', t), false);
  assert.equal(hasPassedToday('xx', 'UTC', t), false);
});

test('spring-forward day (Europe/Zurich 2026-03-29, 02:00 -> 03:00)', () => {
  assert.deepEqual(zonedNow('Europe/Zurich', at('2026-03-29T00:30:00Z')), { date: '2026-03-29', minutes: 90 }); // 01:30 CET
  assert.deepEqual(zonedNow('Europe/Zurich', at('2026-03-29T01:00:00Z')), { date: '2026-03-29', minutes: 180 }); // 03:00 CEST
  // a time inside the skipped hour is already behind us once the clock reads 03:00
  assert.equal(hasPassedToday('02:30', 'Europe/Zurich', at('2026-03-29T01:00:00Z')), true);
  assert.equal(hasPassedToday('02:30', 'Europe/Zurich', at('2026-03-29T00:59:00Z')), false);
  assert.equal(nextReminderDay('07:30', 'Europe/Zurich', at('2026-03-29T01:00:00Z')), 'today');
  // the day before: still CET, 07:30 is 06:30Z
  assert.equal(hasPassedToday('07:30', 'Europe/Zurich', at('2026-03-28T06:29:00Z')), false);
  assert.equal(hasPassedToday('07:30', 'Europe/Zurich', at('2026-03-28T06:30:00Z')), true);
  // the day itself: 07:30 CEST is 05:30Z
  assert.equal(hasPassedToday('07:30', 'Europe/Zurich', at('2026-03-29T05:29:00Z')), false);
  assert.equal(hasPassedToday('07:30', 'Europe/Zurich', at('2026-03-29T05:30:00Z')), true);
});

test('fall-back day (Europe/Zurich 2026-10-25, 03:00 -> 02:00): the repeated hour is seen twice', () => {
  assert.equal(zonedNow('Europe/Zurich', at('2026-10-25T00:30:00Z')).minutes, 150); // 02:30 CEST
  assert.equal(zonedNow('Europe/Zurich', at('2026-10-25T01:30:00Z')).minutes, 150); // 02:30 CET
  assert.equal(hasPassedToday('02:30', 'Europe/Zurich', at('2026-10-25T01:30:00Z')), true);
  assert.equal(nextReminderDay('02:45', 'Europe/Zurich', at('2026-10-25T01:30:00Z')), 'today');
  assert.equal(nextReminderDay('07:30', 'Europe/Zurich', at('2026-10-25T05:00:00Z')), 'today'); // 06:00 CET
});

test('US DST (America/New_York 2026-03-08)', () => {
  assert.deepEqual(zonedNow('America/New_York', at('2026-03-08T06:59:00Z')), { date: '2026-03-08', minutes: 119 }); // 01:59 EST
  assert.deepEqual(zonedNow('America/New_York', at('2026-03-08T07:00:00Z')), { date: '2026-03-08', minutes: 180 }); // 03:00 EDT
  assert.equal(hasPassedToday('07:30', 'America/New_York', at('2026-03-08T11:29:00Z')), false); // 07:29 EDT
  assert.equal(hasPassedToday('07:30', 'America/New_York', at('2026-03-08T11:30:00Z')), true);
});

test('southern hemisphere DST (Pacific/Auckland 2026-09-27, +12 -> +13)', () => {
  assert.deepEqual(zonedNow('Pacific/Auckland', at('2026-09-26T13:59:00Z')), { date: '2026-09-27', minutes: 119 }); // 01:59 NZST
  assert.deepEqual(zonedNow('Pacific/Auckland', at('2026-09-26T14:00:00Z')), { date: '2026-09-27', minutes: 180 }); // 03:00 NZDT
});

test('nextReminderDay: today while the time is ahead, tomorrow once passed or already sent today', () => {
  const t = at('2026-06-15T05:00:00Z'); // 07:00 Zurich
  assert.equal(nextReminderDay('07:30', 'Europe/Zurich', t), 'today');
  assert.equal(nextReminderDay('07:00', 'Europe/Zurich', t), 'tomorrow');
  assert.equal(nextReminderDay('06:00', 'Europe/Zurich', t), 'tomorrow');
  assert.equal(nextReminderDay('07:30', 'Europe/Zurich', t, '2026-06-15'), 'tomorrow', 'already sent today');
  assert.equal(nextReminderDay('07:30', 'Europe/Zurich', t, '2026-06-14'), 'today');
  assert.equal(nextReminderDay('bad', 'Europe/Zurich', t), null);
});

test('nextReminderText', () => {
  const t = at('2026-06-15T05:00:00Z');
  assert.equal(nextReminderText({ enabled: false, time: '07:30', tz: 'Europe/Zurich' }, t), 'Off');
  assert.equal(nextReminderText({ enabled: true, time: '07:30', tz: 'Europe/Zurich' }, t), 'Next reminder: today 07:30');
  assert.equal(nextReminderText({ enabled: true, time: '06:30', tz: 'Europe/Zurich' }, t), 'Next reminder: tomorrow 06:30');
  assert.equal(nextReminderText({ enabled: true, time: '07:30', tz: 'Asia/Tokyo' }, t), 'Next reminder: tomorrow 07:30'); // 14:00 there
  assert.equal(nextReminderText({}, t), 'Off');
});

test('buildReminderPatch sets lastSentDate only for an enabled time that already passed today in the person tz', () => {
  const t = at('2026-06-15T19:30:00Z'); // 21:30 Zurich
  const late = buildReminderPatch({ enabled: true, time: '20:00', tz: 'Europe/Zurich' }, t);
  assert.deepEqual(late, { enabled: true, time: '20:00', tz: 'Europe/Zurich', updatedTs: t, lastSentDate: '2026-06-15' });
  const early = buildReminderPatch({ enabled: true, time: '22:00', tz: 'Europe/Zurich' }, t);
  assert.ok(!('lastSentDate' in early));
  const off = buildReminderPatch({ enabled: false, time: '20:00', tz: 'Europe/Zurich' }, t);
  assert.ok(!('lastSentDate' in off));
  assert.equal(off.enabled, false);
  // the same instant is "tomorrow" already in Auckland (UTC+12): date is that zone's date
  const nz = buildReminderPatch({ enabled: true, time: '07:30', tz: 'Pacific/Auckland' }, t);
  assert.equal(nz.lastSentDate, '2026-06-16');
  for (const p of [late, early, off, nz]) assert.ok(Object.values(p).every(v => v !== undefined));
});

test('normalizeReminder fills defaults for missing or malformed data', () => {
  assert.deepEqual(normalizeReminder(null), { enabled: false, time: DEFAULT_REMINDER_TIME, tz: '', lastSentDate: null, updatedTs: 0 });
  assert.equal(DEFAULT_REMINDER_TIME, '07:30');
  assert.deepEqual(
    normalizeReminder({ enabled: true, time: '06:45', tz: 'Europe/Zurich', lastSentDate: '2026-06-14', updatedTs: 5 }),
    { enabled: true, time: '06:45', tz: 'Europe/Zurich', lastSentDate: '2026-06-14', updatedTs: 5 }
  );
  assert.equal(normalizeReminder({ enabled: 'yes', time: '7:5' }).enabled, false);
  assert.equal(normalizeReminder({ time: '7:5' }).time, '07:30');
});
