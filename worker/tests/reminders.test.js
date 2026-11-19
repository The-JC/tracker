import { test } from 'node:test';
import assert from 'node:assert/strict';
import { dueCheck, localParts, resolveTz, parseTime, runReminders, WINDOW_MINUTES, DEFAULT_TZ } from '../src/reminders.js';
import { ENV, vapid, makeSub } from './helpers.js';
import index from '../src/index.js';

const utc = (y, mo, d, h = 0, mi = 0) => Date.UTC(y, mo - 1, d, h, mi);
const cfg = (o = {}) => ({ enabled: true, time: '07:30', tz: 'Europe/Zurich', lastSentDate: null, updatedTs: 1, ...o });

/* ---------- time zone maths ---------- */

test('parseTime / resolveTz', () => {
  assert.equal(parseTime('07:30'), 450); assert.equal(parseTime('00:00'), 0); assert.equal(parseTime('23:59'), 1439);
  for (const bad of ['24:00', '7:30', '07:60', '', null, undefined, 730, '07:30:00']) assert.equal(parseTime(bad), null, String(bad));
  assert.equal(resolveTz('America/Los_Angeles'), 'America/Los_Angeles');
  for (const bad of ['Mars/Olympus', '', null, undefined, 5, 'x'.repeat(100)]) assert.equal(resolveTz(bad), DEFAULT_TZ, String(bad));
  assert.equal(DEFAULT_TZ, 'Europe/Zurich');
  assert.equal(WINDOW_MINUTES, 180);
});

test('localParts: the same instant has a different local date and time per zone', () => {
  const t = utc(2026, 6, 15, 22, 30);
  assert.deepEqual(localParts(t, 'Europe/Zurich'), { tz: 'Europe/Zurich', date: '2026-06-16', minutes: 30 });          // CEST +2
  assert.deepEqual(localParts(t, 'America/Los_Angeles'), { tz: 'America/Los_Angeles', date: '2026-06-15', minutes: 15 * 60 + 30 }); // PDT -7
  assert.deepEqual(localParts(t, 'Pacific/Auckland'), { tz: 'Pacific/Auckland', date: '2026-06-16', minutes: 10 * 60 + 30 });      // NZST +12
  assert.equal(localParts(t, 'garbage').tz, 'Europe/Zurich');
  assert.equal(localParts(utc(2026, 12, 31, 23, 59), 'UTC').date, '2026-12-31');
  assert.equal(localParts(utc(2026, 12, 31, 23, 59), 'Europe/Zurich').date, '2027-01-01');
  assert.equal(localParts(utc(2026, 3, 3, 23, 0), 'Europe/Zurich').minutes, 0); // midnight is 0, never 24:00
});

test('dueCheck: window edges (Zurich, time 07:30, winter)', () => {
  // 07:30 local = 06:30Z
  const at = mins => utc(2026, 1, 12, 6, 30 + mins);
  assert.equal(dueCheck(cfg(), at(-1)).why, 'too-early');
  assert.equal(dueCheck(cfg(), at(0)).due, true);
  assert.equal(dueCheck(cfg(), at(5)).due, true);
  assert.equal(dueCheck(cfg(), at(179)).due, true);
  assert.equal(dueCheck(cfg(), at(180)).why, 'window-over');
  assert.equal(dueCheck(cfg(), at(600)).why, 'window-over');
  assert.equal(dueCheck(cfg(), at(0)).date, '2026-01-12');
});

test('dueCheck: disabled, bad time, already sent today, sent yesterday', () => {
  const now = utc(2026, 1, 12, 6, 40);
  assert.equal(dueCheck(cfg({ enabled: false }), now).why, 'disabled');
  assert.equal(dueCheck(cfg({ enabled: 'true' }), now).why, 'disabled');
  assert.equal(dueCheck(undefined, now).why, 'disabled');
  assert.equal(dueCheck(cfg({ time: '7:30' }), now).why, 'bad-time');
  assert.equal(dueCheck(cfg({ lastSentDate: '2026-01-12' }), now).why, 'already-sent');
  assert.equal(dueCheck(cfg({ lastSentDate: '2026-01-11' }), now).due, true);
});

test('dueCheck: window ends at local midnight (late-evening reminders only get the rest of that day)', () => {
  const c = cfg({ time: '22:30' });
  assert.equal(dueCheck(c, utc(2026, 1, 12, 21, 40)).due, true);   // 22:40 local
  assert.equal(dueCheck(c, utc(2026, 1, 12, 22, 59)).due, true);   // 23:59 local
  assert.equal(dueCheck(c, utc(2026, 1, 12, 23, 10)).why, 'too-early'); // 00:10 next day, new date, before 22:30
});

test('dueCheck: invalid tz falls back to Europe/Zurich', () => {
  const now = utc(2026, 1, 12, 6, 40); // 07:40 Zurich
  const r = dueCheck(cfg({ tz: 'Nowhere/Land' }), now);
  assert.equal(r.due, true); assert.equal(r.tz, 'Europe/Zurich');
  assert.equal(dueCheck(cfg({ tz: undefined }), now).tz, 'Europe/Zurich');
});

test('dueCheck: per-zone, the same instant is due for one person and not for another', () => {
  const now = utc(2026, 6, 15, 5, 40); // Zurich 07:40, LA 22:40 the day before, Auckland 17:40
  assert.equal(dueCheck(cfg({ tz: 'Europe/Zurich' }), now).due, true);
  assert.equal(dueCheck(cfg({ tz: 'America/Los_Angeles' }), now).why, 'window-over');  // 22:40 the evening before, past 10:30
  assert.equal(dueCheck(cfg({ tz: 'America/Los_Angeles', time: '22:00' }), now).due, true);
  assert.equal(dueCheck(cfg({ tz: 'Pacific/Auckland' }), now).why, 'window-over');     // 17:40 vs 07:30
});

test('DST Europe/Zurich spring forward 2026-03-29: a time inside the skipped hour fires at 03:00', () => {
  const c = cfg({ time: '02:30' });
  assert.equal(dueCheck(c, utc(2026, 3, 29, 0, 55)).why, 'too-early'); // 01:55 CET
  const r = dueCheck(c, utc(2026, 3, 29, 1, 0));                       // 03:00 CEST
  assert.equal(r.due, true); assert.equal(r.date, '2026-03-29');
  assert.equal(dueCheck(cfg({ time: '07:30' }), utc(2026, 3, 29, 5, 30)).due, true); // 07:30 CEST = 05:30Z, normal after the change
  assert.equal(dueCheck(cfg({ time: '07:30' }), utc(2026, 3, 29, 6, 30)).due, true); // 08:30 CEST, inside the window
  assert.equal(dueCheck(cfg({ time: '07:30' }), utc(2026, 3, 29, 8, 30)).why, 'window-over'); // 10:30 CEST
});

test('DST Europe/Zurich fall back 2026-10-25: 02:30 happens twice but only fires once (lastSentDate)', () => {
  const c = cfg({ time: '02:30' });
  const first = utc(2026, 10, 25, 0, 30);  // 02:30 CEST
  const second = utc(2026, 10, 25, 1, 30); // 02:30 CET again
  assert.equal(dueCheck(c, first).due, true);
  assert.equal(dueCheck(c, second).due, true, 'before anything was sent the repeated hour is still due');
  assert.equal(dueCheck({ ...c, lastSentDate: '2026-10-25' }, second).why, 'already-sent');
  // local-clock window: 01:00 + 3h is 04:00 local, i.e. 4 real hours that night
  const e = cfg({ time: '01:00' });
  assert.equal(dueCheck(e, utc(2026, 10, 25, 2, 59)).due, true);  // 03:59 CET
  assert.equal(dueCheck(e, utc(2026, 10, 25, 3, 0)).why, 'window-over'); // 04:00 CET
});

test('DST America/Los_Angeles 2026-03-08 and 2026-11-01', () => {
  const c = cfg({ tz: 'America/Los_Angeles', time: '02:30' });
  assert.equal(dueCheck(c, utc(2026, 3, 8, 9, 55)).why, 'too-early'); // 01:55 PST
  const r = dueCheck(c, utc(2026, 3, 8, 10, 0));                      // 03:00 PDT
  assert.equal(r.due, true); assert.equal(r.date, '2026-03-08');
  const f = cfg({ tz: 'America/Los_Angeles', time: '07:00' });
  assert.equal(dueCheck(f, utc(2026, 11, 1, 15, 0)).due, true);       // 07:00 PST (UTC-8)
  assert.equal(dueCheck(f, utc(2026, 11, 1, 14, 59)).why, 'too-early');
  assert.equal(dueCheck(f, utc(2026, 11, 1, 15, 0)).date, '2026-11-01');
});

test('DST Pacific/Auckland 2026-09-27 (spring forward) and 2026-04-05 (fall back)', () => {
  const c = cfg({ tz: 'Pacific/Auckland', time: '02:30' });
  assert.equal(dueCheck(c, utc(2026, 9, 26, 13, 55)).why, 'too-early'); // 01:55 NZST
  const r = dueCheck(c, utc(2026, 9, 26, 14, 0));                       // 03:00 NZDT on the 27th
  assert.equal(r.due, true); assert.equal(r.date, '2026-09-27');
  const f = cfg({ tz: 'Pacific/Auckland', time: '07:00' });
  assert.equal(dueCheck(f, utc(2026, 4, 4, 19, 0)).due, true);          // 07:00 NZST on 5 April (UTC+12)
  assert.equal(dueCheck(f, utc(2026, 4, 4, 18, 59)).why, 'too-early');
});

/* ---------- the scheduled run, against a fake world ---------- */

// Tuesday of plan week 1 (start 2026-03-02). Zurich is on CET: 07:45 local = 06:45Z.
const NOW = utc(2026, 3, 3, 6, 45);
const TODAY = '2026-03-03';
const TOKEN = 'sa-access-token';

function world({ reminders, subs = {}, log = {}, settings = {}, goals = null, plans = null, failPush = {}, pushStatus = {}, failDb = {} } = {}) {
  const db = { settings: { startDate: '2026-03-02', ...settings, reminders }, log, goals, plans, subs, nameA: 'Bea', nameB: 'Jules' };
  const calls = []; const lines = [];
  const fetchFn = async (url, init = {}) => {
    const u = new URL(url); const method = init.method || 'GET';
    const call = { method, url: u, headers: init.headers || {}, order: calls.length };
    calls.push(call);
    if (u.host === 'db.example.test') {
      assert.equal(u.searchParams.get('auth'), null, 'the cron has no ID token');
      assert.equal(call.headers.Authorization, `Bearer ${TOKEN}`);
      const path = u.pathname.replace(/\.json$/, '').slice(1).split('/');
      if (failDb[path[1]]) return new Response('boom', { status: 500 });
      if (method === 'PATCH') {
        assert.deepEqual(path.slice(1, 3), ['settings', 'reminders']);
        Object.assign(db.settings.reminders[path[3]], JSON.parse(init.body));
        return new Response('{}');
      }
      if (method === 'DELETE') { const [, , p, k] = path; delete db.subs[p][k]; return new Response('null'); }
      if (path[1] === 'pushSubs') return Response.json(db.subs[path[2]] ?? null);
      if (path[1] === 'nameA' || path[1] === 'nameB') return Response.json(db[path[1]]);
      return Response.json(db[path[1]] ?? null);
    }
    if (failPush[url]) throw new Error('network down');
    return new Response(null, { status: pushStatus[url] || 201 });
  };
  const pushes = () => calls.filter(c => c.url.host === 'push.example.test');
  const patches = () => calls.filter(c => c.method === 'PATCH');
  return { fetchFn, calls, lines, db, pushes, patches, log: (...a) => lines.push(a.join(' ')) };
}

async function run(w, { now = NOW, getToken = async () => TOKEN, env, state } = {}) {
  const e = { ...ENV, ...(await vapid()), ...env };
  return runReminders(e, { fetchFn: w.fetchFn, now: () => now, getToken, log: w.log, state: state || { warned: false } });
}

test('happy path: due reminder claims the day BEFORE pushing, then sends the recommended run', async () => {
  const s = makeSub();
  const w = world({ reminders: { a: cfg() }, subs: { a: { h: s } } });
  const res = await run(w);
  assert.deepEqual(res, [{ person: 'a', status: 'sent', sent: 1, removed: 0 }]);
  assert.equal(w.db.settings.reminders.a.lastSentDate, TODAY);
  assert.equal(w.patches().length, 1);
  assert.ok(w.patches()[0].order < w.pushes()[0].order, 'claim precedes the push');
  assert.equal(w.pushes().length, 1);
  assert.equal(w.pushes()[0].url.href, s.endpoint);
  assert.ok(w.lines.some(l => l.includes('reminder a: sent=1')));
});

test('a second tick the same day sends nothing (already claimed)', async () => {
  const w = world({ reminders: { a: cfg() }, subs: { a: { h: makeSub() } } });
  await run(w);
  const res = await run(w, { now: NOW + 5 * 60000 });
  assert.deepEqual(res, [{ person: 'a', status: 'not-due', why: 'already-sent' }]);
  assert.equal(w.pushes().length, 1);
});

test('claim failure means no push (at-most-once)', async () => {
  const w = world({ reminders: { a: cfg() }, subs: { a: { h: makeSub() } } });
  const orig = w.fetchFn;
  w.fetchFn = async (url, init = {}) => (init.method === 'PATCH' ? new Response('no', { status: 500 }) : orig(url, init));
  const res = await run(w);
  assert.equal(res[0].status, 'error');
  assert.equal(w.pushes().length, 0);
});

test('push failure after the claim is not retried by later ticks (at-most-once)', async () => {
  const s = makeSub();
  const w = world({ reminders: { a: cfg() }, subs: { a: { h: s } }, failPush: { [s.endpoint]: true } });
  assert.equal((await run(w))[0].sent, 0);
  assert.equal(w.db.settings.reminders.a.lastSentDate, TODAY);
  await run(w, { now: NOW + 300000 });
  assert.equal(w.pushes().length, 1, 'only the first (failed) attempt, no retry');
});

test('not due yet / window over / disabled: no reads beyond settings, no writes, no pushes', async () => {
  for (const [c, now] of [[cfg({ time: '08:00' }), NOW], [cfg({ time: '03:00' }), NOW], [cfg({ enabled: false }), NOW]]) {
    const w = world({ reminders: { a: c }, subs: { a: { h: makeSub() } } });
    await run(w, { now });
    assert.equal(w.pushes().length, 0); assert.equal(w.patches().length, 0);
    assert.ok(w.calls.every(x => x.url.pathname === '/trailhead-tracker-v1/settings.json'), 'only the settings read');
  }
});

test('catch-up inside the window: the reminder still goes out up to 3 h late', async () => {
  const w = world({ reminders: { a: cfg({ time: '05:00' }) }, subs: { a: { h: makeSub() } } }); // 07:45 local, 2 h 45 late
  assert.equal((await run(w))[0].status, 'sent');
});

test('kind other than run: no push but the day is still claimed', async () => {
  const w = world({ reminders: { a: cfg() }, subs: { a: { h: makeSub() } }, settings: { startDate: '2026-03-09' } }); // plan not started
  const res = await run(w);
  assert.deepEqual(res, [{ person: 'a', status: 'skipped', why: 'not-started' }]);
  assert.equal(w.pushes().length, 0);
  assert.equal(w.db.settings.reminders.a.lastSentDate, TODAY);
});

test('plans/<person> is read: an own start date later than today means "plan not started" for that person only', async () => {
  const plans = { a: { startDate: '2026-03-09' } }; // settings start 2026-03-02 would be week 1; a's own plan starts next week
  const w = world({ reminders: { a: cfg(), b: cfg() }, subs: { a: { h: makeSub() }, b: { h: makeSub() } }, plans });
  const res = await run(w);
  assert.deepEqual(res, [{ person: 'a', status: 'skipped', why: 'not-started' }, { person: 'b', status: 'sent', sent: 1, removed: 0 }]);
  assert.ok(w.calls.some(c => c.url.pathname === '/trailhead-tracker-v1/plans.json'), 'plans node was read');
});

test('an absent, junk or unreadable plans node behaves exactly like today (settings start date)', async () => {
  for (const extra of [{ plans: null }, { plans: { a: 'junk', b: { startDate: 'not-a-date', mode: 5 } } }, { failDb: { plans: true } }]) {
    const w = world({ reminders: { a: cfg() }, subs: { a: { h: makeSub() } }, ...extra });
    assert.deepEqual(await run(w), [{ person: 'a', status: 'sent', sent: 1, removed: 0 }], JSON.stringify(extra));
  }
});

test('rolling plan state: a reminder only goes out on a training day, from the session queue', async () => {
  // NOW is Tuesday 2026-03-03
  const onDay = world({ reminders: { a: cfg() }, subs: { a: { h: makeSub() } }, plans: { a: { mode: 'rolling', trainingDays: [2, 4, 6] } } });
  assert.deepEqual(await run(onDay), [{ person: 'a', status: 'sent', sent: 1, removed: 0 }]);
  const offDay = world({ reminders: { a: cfg() }, subs: { a: { h: makeSub() } }, plans: { a: { mode: 'rolling', trainingDays: [1, 3, 5] } } });
  assert.deepEqual(await run(offDay), [{ person: 'a', status: 'skipped', why: 'rest' }]);
  assert.equal(offDay.pushes().length, 0);
  assert.equal(offDay.db.settings.reminders.a.lastSentDate, TODAY);
});

test('rolling plan state: a paused day sends nothing, the day after the pause sends; trainingDays are ignored in fixed (calendar) mode', async () => {
  const paused = world({ reminders: { a: cfg() }, subs: { a: { h: makeSub() } }, plans: { a: { mode: 'rolling', pauses: [{ from: '2026-03-02', to: '2026-03-03', note: 'flu' }] } } });
  assert.deepEqual(await run(paused), [{ person: 'a', status: 'skipped', why: 'rest' }]);
  assert.equal(paused.pushes().length, 0);
  const after = world({ reminders: { a: cfg() }, subs: { a: { h: makeSub() } }, plans: { a: { mode: 'rolling', pauses: [{ from: '2026-02-20', to: '2026-03-02' }] } } });
  assert.equal((await run(after))[0].status, 'sent');
  // calendar mode (default) with training days that exclude today: unchanged behaviour, still sends
  const cal = world({ reminders: { a: cfg() }, subs: { a: { h: makeSub() } }, plans: { a: { trainingDays: [1, 3, 5] } } });
  assert.equal((await run(cal))[0].status, 'sent');
});

test('rolling plan state: behind plan (nothing logged for weeks) still only sends on training days, and only reads plans (no write to plans)', async () => {
  const plans = { a: { mode: 'rolling', startDate: '2026-01-05', trainingDays: [2] } }; // today (Tue) is a training day, 8 weeks behind
  const w = world({ reminders: { a: cfg() }, subs: { a: { h: makeSub() } }, plans });
  assert.equal((await run(w))[0].status, 'sent');
  assert.ok(w.calls.every(c => c.method === 'GET' || c.url.pathname.startsWith('/trailhead-tracker-v1/settings/reminders/') || c.url.host !== 'db.example.test'), 'no DB write outside settings/reminders');
});

test('rest recommendation (ran yesterday three days in a row) is skipped and claimed', async () => {
  const log = {
    l1: { person: 'a', sport: 'run', runType: 'easy', km: 5, date: '2026-03-02', ts: 1 },
    l2: { person: 'a', sport: 'run', runType: 'easy', km: 5, date: '2026-03-01', ts: 2 },
    l3: { person: 'a', sport: 'run', runType: 'easy', km: 5, date: '2026-02-28', ts: 3 }
  };
  const w = world({ reminders: { a: cfg() }, subs: { a: { h: makeSub() } }, log });
  const res = await run(w);
  assert.equal(res[0].status, 'skipped');
  assert.equal(w.pushes().length, 0);
  assert.equal(w.db.settings.reminders.a.lastSentDate, TODAY);
});

test('already logged any activity dated today: skipped and claimed', async () => {
  const log = { x: { person: 'a', sport: 'hike', km: 9, date: TODAY, ts: 1 } }; // not even a run
  const w = world({ reminders: { a: cfg() }, subs: { a: { h: makeSub() } }, log });
  assert.deepEqual(await run(w), [{ person: 'a', status: 'skipped', why: 'logged-today' }]);
  assert.equal(w.pushes().length, 0);
  assert.equal(w.db.settings.reminders.a.lastSentDate, TODAY);
  // somebody else's activity today does not count
  const w2 = world({ reminders: { a: cfg() }, subs: { a: { h: makeSub() } }, log: { x: { person: 'b', sport: 'run', km: 5, date: TODAY, ts: 1 } } });
  assert.equal((await run(w2))[0].status, 'sent');
});

test('no subscription: silent skip, day not claimed (subscribing later still works)', async () => {
  const w = world({ reminders: { a: cfg() }, subs: {} });
  assert.deepEqual(await run(w), [{ person: 'a', status: 'no-subscription' }]);
  assert.equal(w.patches().length, 0);
  assert.deepEqual(w.lines, []);
  w.db.subs.a = { h: makeSub() };
  assert.equal((await run(w, { now: NOW + 300000 }))[0].status, 'sent');
});

test('per-person isolation: own time zone, own subscriptions, one failing does not block the other', async () => {
  const sb = makeSub();
  const w = world({
    reminders: { a: cfg({ time: '07:30' }), b: cfg({ tz: 'Pacific/Auckland', time: '18:30' }) }, // b: 19:45 NZDT (UTC+13)
    subs: { a: { h: makeSub() }, b: { h: sb } }
  });
  // make a's recommendation read blow up: fail the log read only for the first call
  let blown = false;
  const orig = w.fetchFn;
  w.fetchFn = async (url, init = {}) => {
    if (!blown && new URL(url).pathname.endsWith('/log.json')) { blown = true; return new Response('x', { status: 500 }); }
    return orig(url, init);
  };
  const res = await run(w);
  assert.equal(res.find(r => r.person === 'a').status, 'error');
  assert.equal(res.find(r => r.person === 'b').status, 'sent');
  assert.equal(w.pushes().length, 1);
  assert.equal(w.pushes()[0].url.href, sb.endpoint);
  assert.equal(w.db.settings.reminders.a.lastSentDate, null, 'a failed before claiming');
  assert.equal(w.db.settings.reminders.b.lastSentDate, '2026-03-03', 'b has its own local date');
});

test('invalid tz in the data falls back to Europe/Zurich and still sends', async () => {
  const w = world({ reminders: { a: cfg({ tz: 'Not/AZone' }) }, subs: { a: { h: makeSub() } } });
  assert.equal((await run(w))[0].status, 'sent');
  assert.equal(w.db.settings.reminders.a.lastSentDate, TODAY);
});

test('dead subscriptions (410) are deleted with the service account', async () => {
  const dead = makeSub(), live = makeSub();
  const w = world({ reminders: { a: cfg() }, subs: { a: { d: dead, l: live } }, pushStatus: { [dead.endpoint]: 410 } });
  const res = await run(w);
  assert.deepEqual(res, [{ person: 'a', status: 'sent', sent: 1, removed: 1 }]);
  assert.deepEqual(Object.keys(w.db.subs.a), ['l']);
});

test('missing VAPID key: error, and the day is NOT burned', async () => {
  const w = world({ reminders: { a: cfg() }, subs: { a: { h: makeSub() } } });
  const res = await run(w, { env: { VAPID_PRIVATE_KEY: 'bad' } });
  assert.equal(res[0].status, 'error');
  assert.equal(w.db.settings.reminders.a.lastSentDate, null);
});

test('no service account: logs "reminders disabled: no service account" once and does nothing', async () => {
  const w = world({ reminders: { a: cfg() }, subs: { a: { h: makeSub() } } });
  const state = { warned: false };
  assert.deepEqual(await run(w, { getToken: null, state }), []);
  await run(w, { getToken: null, state });
  assert.deepEqual(w.lines, ['reminders disabled: no service account']);
  assert.equal(w.calls.length, 0);
});

test('scheduled never throws: token failure, settings failure, garbage data, throwing logger', async () => {
  const w = world({ reminders: { a: cfg() }, subs: { a: { h: makeSub() } } });
  assert.deepEqual(await run(w, { getToken: async () => { throw new Error('oauth down'); } }), []);
  assert.ok(w.lines.some(l => l.includes('oauth down')));
  const w2 = world({ reminders: { a: cfg() }, failDb: { settings: true } });
  assert.deepEqual(await run(w2), []);
  for (const bad of [null, 'str', 5, [], { a: 'x', b: null }, { a: { enabled: true, time: {} } }]) {
    const w3 = world({ reminders: bad });
    await assert.doesNotReject(run(w3));
  }
  const w4 = world({ reminders: { a: cfg() }, subs: { a: { h: makeSub() } } });
  w4.log = () => { throw new Error('logger broke'); };
  await assert.doesNotReject(runReminders({ ...ENV, ...(await vapid()) }, { fetchFn: w4.fetchFn, now: () => NOW, getToken: async () => TOKEN, log: w4.log, state: { warned: true } }));
});

test('log lines are concise and never contain the token or endpoint', async () => {
  const s = makeSub();
  const w = world({ reminders: { a: cfg() }, subs: { a: { h: s } } });
  await run(w);
  const all = w.lines.join('\n');
  assert.ok(!all.includes(TOKEN) && !all.includes(s.endpoint));
});

test('the Worker default export has fetch and scheduled; scheduled resolves without a secret', async () => {
  assert.equal(typeof index.fetch, 'function'); assert.equal(typeof index.scheduled, 'function');
  const waited = [];
  const lines = []; const orig = console.log; console.log = (...a) => lines.push(a.join(' '));
  try {
    await index.scheduled({ scheduledTime: NOW }, { ...ENV }, { waitUntil: p => waited.push(p) });
    await Promise.all(waited);
  } finally { console.log = orig; }
  assert.equal(waited.length, 1);
});
