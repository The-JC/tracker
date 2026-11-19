// "Which run next?" recommendation engine. Pure, deterministic and offline: no Vue, no Firebase, no clock.
// Everything it needs (today, plan start, log, goals) is passed in, so it is unit-testable in node.
//
// How it works, in one paragraph
//   1. The runs one person logged in the current plan week are matched to that week's planned runs
//      (same run type first, closest km first; leftovers by km closeness). A planned run is done when the
//      matched logged km reach DONE_THRESHOLD of its target. The unmatched / unfinished planned runs are the candidates.
//   2. Every candidate gets a score from transparent rules about the day of the week and the recent load
//      (see SCORE below). Hard runs are never recommended right after a hard or long run.
//   3. Special modes override the scoring: race week, catch-up (more runs left than days), rest after
//      a run today / three run days in a row, a week that is already done, a plan that has not started.
//   The result carries a human reason and tags that say which rule fired.
//
// Dates are local calendar dates 'YYYY-MM-DD'; all date maths goes through scoring.js (UTC based, DST safe).
import { PLAN } from './plan.js';
import { buildWeeks, weekOfEntry, weekForDate, addDays, daysBetween, mondayOf, formatKm } from './scoring.js';
import { effectiveStartFor, personPlanState } from './planModel.js';
import { DONE_THRESHOLD, buildSessions, matchRuns, nextOpenSession, raceFeasibility } from './rolling.js';

/* ---------- tunable constants ---------- */

// A planned run counts as done when the matched logged distance is at least this share of its target km (defined in rolling.js).
export { DONE_THRESHOLD };
// Run types with a multiplier at or above this are "hard efforts" (tempo 1.6, speed 1.8, race 3).
export const HARD_MULT = 1.6;
// A hard run is not recommended the day after a hard run or a long run.
// This many consecutive run days (ending yesterday) trigger a rest-day suggestion (unless you are behind).
export const REST_AFTER_RUN_DAYS = 3;
// More than this many days without a run (strictly greater) = "ease back in": easy run preferred, no hard or long run.
export const EASE_BACK_AFTER_DAYS = 5;
// A candidate scoring at or below this is "better on another day": the recommendation becomes a rest day.
export const AVOID_SCORE = -40;

// Score adjustments (higher = better today). Ties are broken by plan order.
export const SCORE = {
  weekendLong: 50,        // (b) long run on Saturday / Sunday
  weekdayLong: -40,       // (b) long run Mon-Thu while a weekend day is still ahead and you are not behind
  fridayLong: -10,        //     Friday: possible but the weekend is better
  longAfterHard: -20,     //     long run the day after a tempo / speed run
  midweekQuality: 30,     // (c) tempo / speed on Tue-Thu
  mondayQuality: -5,      //     Monday: ease into the week
  fridayQuality: -20,     //     Friday: too close to the weekend long run (only while a long run is still open)
  weekendQuality: -25,    //     Sat / Sun while the long run is still open (the long run has priority)
  tightQuality: 40,       //     "every remaining day is needed": do the hard efforts first, easy ones fit anywhere
  recoveryEasy: 40,       // (a) easy run the day after a hard / long run
  openerEasy: 15,         //     easy run on Monday or Friday
  easeBackEasy: 30,       // (h) after a long break: easy run preferred ...
  easeBackHard: -30       //     ... and hard / long runs discouraged
};

/* ---------- small helpers ---------- */

const WEEKDAYS = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday'];
const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
const isoMs = iso => { const [y, m, d] = iso.split('-').map(Number); return Date.UTC(y, m - 1, d); };
// 1 = Monday ... 7 = Sunday
const dowOf = iso => ((new Date(isoMs(iso)).getUTCDay() + 6) % 7) + 1;
const weekdayName = iso => WEEKDAYS[new Date(isoMs(iso)).getUTCDay()];
const shortDate = iso => { const [, m, d] = iso.split('-').map(Number); return `${d} ${MONTHS[m - 1]}`; };
const lower = s => (s ? s.charAt(0).toLowerCase() + s.slice(1) : s);
const round1 = x => Math.round(x * 10) / 10;
const isWeekend = dow => dow >= 6;
const plural = (n, one, many) => `${n} ${n === 1 ? one : many}`;

const isHardType = (runType, mult) => (mult != null ? mult >= HARD_MULT : ['tempo', 'speed', 'race'].includes(runType));
const isQualityType = t => t === 'tempo' || t === 'speed';

const label = run => (run.km ? `${run.type} ${formatKm(run.km)} km` : run.type);
const pts = run => formatKm((run.km || 0) * run.mult);
const withDetail = run => `${label(run)}${run.detail ? ` (${run.detail})` : ''}`;

// Plain, serialisable view of a planned run.
function runView(r, weekN) {
  const km = r.km > 0 ? r.km : null;
  return {
    id: r.id, type: r.type, runType: r.runType, km, detail: r.detail || '', mult: r.mult,
    points: km ? round1(km * r.mult) : 0, week: weekN
  };
}

/* ---------- matching logged runs to planned runs ---------- */

// planned: [{ id, km, runType, ... }] (km 0 / null = optional), logged: [{ id, km, runType }] in chronological order.
// Greedy: first pairs of the same run type, then leftovers by km closeness (optional planned runs only match their own type).
// Within a stage, pairs that reach DONE_THRESHOLD win over smaller ones, then the closest km wins.
// -> [{ run, done, partial, optional, matchedKm, entryId }] in planned order.
export function matchWeekRuns(planned, logged) {
  const target = r => (r.km > 0 ? r.km : 0);
  const items = planned.map(run => ({ run, done: false, partial: false, optional: !(run.km > 0), matchedKm: 0, entryId: null }));
  const usedLogged = new Set();
  const usedPlanned = new Set();
  const assign = (li, pi) => {
    usedLogged.add(li); usedPlanned.add(pi);
    const it = items[pi];
    const km = Number(logged[li].km);
    it.matchedKm = km;
    it.entryId = logged[li].id ?? null;
    it.done = it.optional ? km > 0 : km + 1e-9 >= DONE_THRESHOLD * target(it.run);
    it.partial = !it.done;
  };
  const stage = allow => {
    const pairs = [];
    logged.forEach((l, li) => {
      if (usedLogged.has(li)) return;
      planned.forEach((p, pi) => {
        if (usedPlanned.has(pi) || !allow(l, p)) return;
        const reaches = Number(l.km) + 1e-9 >= DONE_THRESHOLD * target(p) ? 0 : 1;
        pairs.push({ li, pi, reaches, diff: Math.abs(Number(l.km) - target(p)) });
      });
    });
    pairs.sort((x, y) => x.reaches - y.reaches || x.diff - y.diff || x.pi - y.pi || x.li - y.li);
    for (const { li, pi } of pairs) if (!usedLogged.has(li) && !usedPlanned.has(pi)) assign(li, pi);
  };
  stage((l, p) => (l.runType || 'easy') === p.runType);
  stage((l, p) => p.km > 0);
  return items;
}

/* ---------- context: week, matches, recent load ---------- */

function resolve(input) {
  const { person, goals = {} } = input;
  const today = input.todayISO;
  const log = Array.isArray(input.log) ? input.log : [];
  const plan = input.plan || PLAN;
  // The person's own plan start: passed in (recommendForPerson does), else from their plan state (planModel), never a global one.
  const startDate = input.startDate || effectiveStartFor(person, input.planState, log, today);
  const weeks = input.weeks || buildWeeks(plan, goals, log, startDate, today);
  const weekN = weekForDate(startDate, today);
  const week = weekN >= 1 && weekN <= weeks.length ? weeks[weekN - 1] : null;
  const mine = log.filter(e => e && e.sport === 'run' && Number(e.km) > 0 && (!person || e.person === person));

  // Rolling mode (planState.mode === 'rolling'): the candidates come from the person's session queue, not from the calendar week.
  const pState = person === 'a' || person === 'b' ? personPlanState(input.planState, person) : null;
  if (pState && pState.mode === 'rolling') return resolveRolling({ ...input, startDate, plan, weeks, today, weekN, week, mine, log }, pState);

  let items = [];
  if (week) {
    const planned = week[person].runs.map(r => ({ ...r }));
    const logged = mine
      .filter(e => weekOfEntry(e, startDate) === weekN)
      .sort((x, y) => (x.date || '').localeCompare(y.date || '') || (x.ts || 0) - (y.ts || 0) || String(x.id).localeCompare(String(y.id)));
    items = matchWeekRuns(planned, logged);
  }
  return { ...input, startDate, plan, weeks, today, weekN, week, mine, items, log, rolling: null };
}

// Context of a person in rolling mode: sessions, matching, and the group (one plan week pass) holding the first open session.
function resolveRolling(c, state) {
  const { person, goals = {}, plan, mine, today, startDate } = c;
  const sessions = buildSessions(plan, goals, state, person);
  const match = matchRuns({ sessions, entries: mine, personState: state, todayISO: today, startDate, person });
  const next = nextOpenSession(sessions, match);
  const group = next ? sessions.filter(s => !s.skipped && s.week === next.week && s.repeat === next.repeat) : [];
  const items = group.map(s => {
    const hit = match.bySession[s.id] || null;
    return {
      run: { id: s.id, type: s.type, runType: s.runType, detail: s.detail, km: s.km, mult: s.mult },
      done: !!hit && !hit.partial, partial: !!hit && hit.partial, matched: !!hit, optional: s.optional,
      matchedKm: hit ? hit.km : 0, entryId: hit ? hit.entryId : null
    };
  });
  return { ...c, weekN: next ? next.week : c.weekN, items, rolling: { sessions, match, state, startDate, next, group } };
}

// Recent load facts from the person's dated runs (imports without a date cannot be used).
function loadFacts(mine, today) {
  const dated = mine.filter(e => e.date && e.date <= today);
  const dates = new Set(dated.map(e => e.date));
  const yesterday = addDays(today, -1);
  const yEntries = dated.filter(e => e.date === yesterday);
  const rank = e => (isHardType(e.runType || 'easy') ? 2 : e.runType === 'long' ? 1 : 0);
  const worst = yEntries.reduce((w, e) => (!w || rank(e) > rank(w) ? e : w), null);
  const yLoad = !worst ? null : rank(worst) === 2 ? 'hard' : rank(worst) === 1 ? 'long' : 'easy';
  let streak = 0;
  for (let d = yesterday; dates.has(d); d = addDays(d, -1)) streak++;
  const last = dated.reduce((m, e) => (e.date > m ? e.date : m), '');
  return {
    ranToday: dates.has(today),
    yLoad,
    yType: worst ? (worst.runType === 'long' ? 'long run' : lower(typeName(worst.runType))) : '',
    streak,
    lastRunDate: last || null,
    daysSince: last ? daysBetween(last, today) : null
  };
}

const TYPE_NAMES = { easy: 'Easy', long: 'Long run', tempo: 'Tempo', speed: 'Speed', shakeout: 'Shakeout', race: 'Race day' };
const typeName = t => TYPE_NAMES[t] || 'Easy';

/* ---------- public: this week's matches (for the card's "x of y done") ---------- */

// -> { weekNumber, items:[{ run, done, partial, optional, matchedKm, entryId }], doneCount, totalCount, optionalCount, remaining:[run] }
// totalCount / doneCount ignore optional planned runs (no km goal, e.g. the race-week shakeout).
export function summarizeWeekMatches(input) {
  const c = resolve(input);
  return summarize(c);
}

function summarize(c) {
  if (c.rolling) return summarizeRolling(c);
  const items = c.items.map(it => ({ ...it, run: runView(it.run, c.weekN) }));
  const required = items.filter(it => !it.optional);
  return {
    weekNumber: c.week ? c.weekN : null,
    items,
    doneCount: required.filter(it => it.done).length,
    totalCount: required.length,
    optionalCount: items.length - required.length,
    remaining: required.filter(it => !it.done).map(it => it.run)
  };
}

// Rolling mode: the group (one plan week pass) holding the first open session; partial runs consumed their session (not remaining).
function summarizeRolling(c) {
  const weekN = c.rolling.next ? c.rolling.next.week : null;
  const items = c.items.map(it => ({ ...it, run: runView(it.run, weekN) }));
  const required = items.filter(it => !it.optional);
  return {
    weekNumber: weekN,
    items,
    doneCount: required.filter(it => it.done).length,
    totalCount: required.length,
    optionalCount: items.length - required.length,
    remaining: required.filter(it => !it.matched).map(it => it.run)
  };
}

/* ---------- public: the recommendation ---------- */

// input: { weeks?, plan?, goals?, person: 'a'|'b', log, todayISO, startDate?, planState? }
//   weeks = store.weeks (buildWeeks output); built from plan/goals/log when omitted.
//   startDate = the person's plan start; derived from planState (planModel states) when omitted.
// -> { kind: 'run'|'rest'|'done'|'ahead'|'not-started', run?, forDate?, reason, tags, alternatives:[{run, why}],
//      plannedLeft, daysLeftInWeek, weekNumber, summary }
//   kind 'run'          run to do today (forDate = today)
//   kind 'rest'         no run today; `run` (with forDate) is the next one up, when there is one
//   kind 'done'         the week (or the plan) is complete; alternatives[0] previews the next week
//   kind 'ahead'        like done, but with two or more days to spare
//   kind 'not-started'  today is before the plan start; alternatives[0] previews week 1
export function recommendNext(input) {
  return decide(resolve(input), input._depth || 0);
}

function decide(c, depth) {
  if (c.rolling) return decideRolling(c, depth);
  const { today, week, weekN, weeks } = c;
  const summary = summarize(c);
  const daysLeft = week ? Math.max(0, daysBetween(today, week.endDate) + 1) : 0;
  const remainingItems = c.items.filter(it => !it.optional && !it.done);
  const base = { weekNumber: week ? weekN : null, summary, plannedLeft: remainingItems.length, daysLeftInWeek: daysLeft };
  const result = (kind, extra) => ({ kind, tags: [], alternatives: [], ...base, ...extra });

  /* --- outside the plan --- */
  if (weekN < 1) {
    const first = firstRun(weeks, 1, c.person);
    const startsOn = c.startDate;
    const inDays = daysBetween(today, startsOn);
    const when = inDays === 1 ? 'tomorrow' : `on ${weekdayName(startsOn)} ${shortDate(startsOn)} (in ${inDays} days)`;
    return result('not-started', {
      reason: first
        ? `Your plan starts ${when}. Week 1 opens with ${label(first)}.`
        : `Your plan starts ${when}.`,
      tags: ['Plan not started'],
      alternatives: first ? [{ run: first, why: 'First planned run' }] : [],
      plannedLeft: weeks[0] ? weeks[0][c.person].runs.filter(r => r.km > 0).length : 0,
      daysLeftInWeek: 0,
      startsOn, startsInDays: inDays
    });
  }
  if (!week) {
    return result('done', {
      reason: `All ${weeks.length} weeks of the plan are behind you. Enjoy the finish and keep running because you love it.`,
      tags: ['Plan complete']
    });
  }

  const facts = loadFacts(c.mine, today);
  const isLastWeek = weekN >= weeks.length;
  const nextFirst = isLastWeek ? null : firstRun(weeks, weekN + 1, c.person);
  const nextStart = addDays(week.endDate, 1);

  /* --- the week is complete --- */
  if (remainingItems.length === 0) {
    const doneRuns = summary.doneCount;
    const raceDone = c.items.some(it => it.run.runType === 'race' && it.done);
    if (isLastWeek) {
      return result('done', {
        reason: raceDone
          ? `Race done: that is the whole ${weeks.length}-week plan finished. Be proud and rest well.`
          : `Week ${weekN} is complete: all ${doneRuns} planned runs are logged, the plan is finished.`,
        tags: ['Plan complete']
      });
    }
    const preview = nextFirst
      ? { alternatives: [{ run: nextFirst, why: `Week ${weekN + 1} starts ${weekdayName(nextStart)} ${shortDate(nextStart)}` }] }
      : {};
    const ahead = daysLeft >= 3;
    const next = nextFirst ? ` Week ${weekN + 1} opens on ${weekdayName(nextStart)} with ${label(nextFirst)}.` : '';
    if (ahead) {
      return result('ahead', {
        reason: `You are ahead of plan: all ${plural(doneRuns, 'planned run', 'planned runs')} of week ${weekN} are done with ${daysLeft - 1} days to spare. Rest and recover.${next}`,
        tags: ['Ahead of plan'], ...preview
      });
    }
    return result('done', {
      reason: `Week ${weekN} is done: all ${plural(doneRuns, 'planned run', 'planned runs')} logged.${next}`,
      tags: ['Week complete'], ...preview
    });
  }

  /* --- a run today already: rest, preview tomorrow --- */
  if (facts.ranToday) {
    return restWithTomorrow(c, base, result, 'You already ran today, so rest up.', 'Rest day', remainingItems, depth);
  }

  const remaining = remainingItems.map(it => runView(it.run, weekN));
  const dow = dowOf(today);
  const weekendLeft = nextWeekendDay(today, week.endDate) !== null;
  const ctx = {
    dow, today, week, weekN, daysLeft, remaining, weekendLeft, facts,
    behind: remaining.length > daysLeft,
    tight: remaining.length === daysLeft && remaining.length >= 2,
    longOpen: remaining.some(r => r.runType === 'long'),
    easeBack: facts.daysSince != null && facts.daysSince > EASE_BACK_AFTER_DAYS
  };

  /* --- race week --- */
  const raceRun = remaining.find(r => r.runType === 'race');
  if (raceRun) return raceWeek(c, ctx, raceRun, result);

  /* --- three run days in a row: rest unless behind --- */
  if (facts.streak >= REST_AFTER_RUN_DAYS && !ctx.behind && !ctx.tight) {
    return restWithTomorrow(c, base, result,
      `You have run ${facts.streak} days in a row, so take a rest day to absorb the training.`, 'Rest day', remainingItems, depth);
  }

  /* --- score the candidates --- */
  const scored = remaining.map((r, i) => assess(r, i, ctx)).sort((x, y) => (x.blocked - y.blocked) || (y.score - x.score) || (x.idx - y.idx));
  let pool = scored.filter(s => !s.blocked);
  if (ctx.behind) pool = [...pool].sort((x, y) => (y.run.mult * (y.run.km || 0)) - (x.run.mult * (x.run.km || 0)) || x.idx - y.idx);
  const best = pool[0];

  // Nothing is safe today (hard run after a hard / long run): rest, then the best one.
  if (!best) {
    const top = scored[0];
    const tomorrow = addDays(today, 1);
    const canWait = tomorrow <= week.endDate;
    return result('rest', {
      reason: `Rest today: ${lower(label(top.run))} is a hard effort and yesterday's ${facts.yType} still counts.${canWait ? ' A rest or easy day first, then it is safe.' : ` The week ends ${weekdayName(week.endDate)}, so skip it or move it to next week.`}`,
      tags: ['Rest day', 'Recovery'],
      ...(canWait ? { run: top.run, forDate: tomorrow } : {}),
      alternatives: scored.slice(1, 3).map(altOf)
    });
  }

  // Everything is better on another day (e.g. only the long run is left on a Wednesday): rest, save it.
  if (!ctx.behind && best.score <= AVOID_SCORE) {
    const forDate = nextWeekendDay(today, week.endDate) || addDays(today, 1);
    return result('rest', {
      reason: `Rest or a short, easy jog today. The ${formatKm(best.run.km)} km ${lower(best.run.type)} is best on ${weekdayName(forDate)}, when you have time and fresh legs.`,
      tags: ['Rest day', best.run.runType === 'long' ? 'Weekend long run' : 'Save it'],
      run: best.run, forDate,
      alternatives: scored.filter(s => s !== best).slice(0, 2).map(altOf)
    });
  }

  const alternatives = scored.filter(s => s !== best).slice(0, 2).map(altOf);
  const { reason, tags } = explain(best, ctx, pool);
  return result('run', { run: best.run, forDate: today, reason, tags, alternatives });
}

/* ---------- scoring ---------- */

function assess(run, idx, ctx) {
  const { dow, facts } = ctx;
  const t = run.runType;
  const hardYesterday = facts.yLoad === 'hard' || facts.yLoad === 'long';
  const o = { run, idx, score: 0, blocked: false, notes: [], flags: new Set() };
  const add = (n, note, flag) => { o.score += n; if (note) o.notes.push(note); if (flag) o.flags.add(flag); };

  if (isHardType(t, run.mult) && hardYesterday) {
    o.blocked = true;
    o.notes.push(`Not today: a hard effort needs an easier day after yesterday's ${facts.yType}.`);
  }
  if (t === 'long') {
    if (facts.yLoad === 'hard') add(SCORE.longAfterHard, `Better after a rest day: yesterday's ${facts.yType} was hard.`, 'afterHard');
    if (longDay(ctx, dow)) add(SCORE.weekendLong, 'Long runs fit best on the weekend.', 'weekendLong');
    else if (!ctx.behind && ctx.weekendLeft && dow <= 4) add(SCORE.weekdayLong, `Save it for the weekend (${nextWeekendName(ctx)}).`, 'weekdayLong');
    else if (!ctx.behind && ctx.weekendLeft && dow === 5) add(SCORE.fridayLong, 'The weekend suits a long run better.', 'weekdayLong');
  } else if (isQualityType(t)) {
    if (ctx.tight) add(SCORE.tightQuality, 'Hard efforts go first when every remaining day is needed.', 'tight');
    else if (qualityDay(ctx, dow)) add(SCORE.midweekQuality, 'Quality work fits Tuesday to Thursday.', 'midweek');
    else if (dow === 1) add(SCORE.mondayQuality, 'Better after an easier start to the week.');
    else if (dow === 5 && ctx.longOpen && !ctx.behind) add(SCORE.fridayQuality, 'Too close to the weekend long run.');
    else if (longDay(ctx, dow) && ctx.longOpen && !ctx.behind) add(SCORE.weekendQuality, 'The long run has priority on the weekend.');
  } else { // easy / shakeout
    if (hardYesterday) add(SCORE.recoveryEasy, null, 'recovery');
    else if (dow === 1 || dow === 5) add(SCORE.openerEasy, null, 'opener');
  }
  if (ctx.easeBack) {
    if (t === 'easy' || t === 'shakeout') add(SCORE.easeBackEasy, null, 'easeBack');
    else if (!o.blocked) add(SCORE.easeBackHard, 'Ease back in first with an easy run.', 'easeBack');
  }
  return o;
}

// Day preferences: Saturday / Sunday for the long run and Tuesday to Thursday for quality, unless the person's training days
// (rolling mode, ctx.isLongDay / ctx.isQualityDay) say otherwise.
const longDay = (ctx, dow) => (ctx.isLongDay ? ctx.isLongDay(dow) : isWeekend(dow));
const qualityDay = (ctx, dow) => (ctx.isQualityDay ? ctx.isQualityDay(dow) : dow >= 2 && dow <= 4);

const altOf = s => ({ run: s.run, why: s.notes[0] || `Also open this week (${pts(s.run)} pts).` });

function nextWeekendDay(today, endDate) {
  for (let i = 1; i <= 7; i++) {
    const d = addDays(today, i);
    if (d > endDate) return null;
    if (isWeekend(dowOf(d))) return d;
  }
  return null;
}
const nextWeekendName = ctx => weekdayName(ctx.week ? (nextWeekendDay(ctx.today, ctx.week.endDate) || ctx.today) : (ctx.nextLongDate || ctx.today));

/* ---------- explanations ---------- */

function explain(best, ctx, pool) {
  const { run } = best;
  const { facts, behind, dow, today } = ctx;
  const others = pool.filter(s => s !== best).map(s => s.run);
  const next = others.length ? ` Next in line: ${label(others[0])}.` : '';
  const tags = [];
  let reason;

  if (behind && !(ctx.rolling && ctx.easeBack)) {
    tags.push('Catch-up');
    reason = ctx.rolling
      ? `Catch-up: you are ${plural(ctx.behindSessions, 'session', 'sessions')} behind plan pace, so the most valuable safe run goes first: ${label(run)}, worth ${pts(run)} points.`
      : `Catch-up: ${plural(ctx.remaining.length, 'run is', 'runs are')} left and only ${plural(ctx.daysLeft, 'day', 'days')} in week ${ctx.weekN}, so the most valuable safe run goes first: ${label(run)}, worth ${pts(run)} points.`;
  } else if (best.flags.has('easeBack') && (run.runType === 'easy' || run.runType === 'shakeout')) {
    tags.push('Ease back in');
    reason = `It's been ${facts.daysSince} days since your last run, so ease back in with the ${formatKm(run.km)} km easy run. Hard and long runs can wait a few days.`;
  } else if (best.flags.has('recovery')) {
    tags.push('Recovery');
    reason = `Yesterday's ${facts.yType} was a hard effort, so keep today easy: ${label(run)} helps you recover.${next}`;
  } else if (run.runType === 'long' && best.flags.has('weekendLong')) {
    tags.push('Weekend long run');
    reason = `It's ${weekdayName(today)}: the ${formatKm(run.km)} km long run (${pts(run)} points) fits best on the weekend, when you have time to go slowly.${next}`;
  } else if (isQualityType(run.runType)) {
    tags.push('Quality day');
    reason = best.flags.has('tight')
      ? `${plural(ctx.remaining.length, 'run is', 'runs are')} left in ${plural(ctx.daysLeft, 'day', 'days')}: ${withDetail(run)} goes first while you are fresh, easy runs fit around it.`
      : `${weekdayName(today)} suits quality: ${withDetail(run)} is worth ${pts(run)} points and you are rested.${next}`;
  } else if (run.runType === 'long') {
    tags.push('Long run');
    reason = `${label(run)} (${pts(run)} points) is what is left to build your endurance this week.${next}`;
  } else {
    tags.push('Easy day');
    reason = dow === 1
      ? `Start the week gently: ${label(run)} builds your base and leaves legs fresh for the harder days.${next}`
      : `${label(run)} builds your base without costing recovery.${next}`;
  }
  if (facts.daysSince != null && facts.daysSince > EASE_BACK_AFTER_DAYS && !tags.includes('Ease back in')) {
    tags.push('Ease back in');
    reason += ` It's been ${facts.daysSince} days since your last run, so keep the effort easy.`;
  }
  return { reason, tags };
}

/* ---------- rest day with tomorrow's preview ---------- */

function restWithTomorrow(c, base, result, lead, tag, remainingItems, depth) {
  const tomorrow = addDays(c.today, 1);
  const tomorrowRec = depth < 1 ? decide(resolve({ ...c, todayISO: tomorrow }), depth + 1) : null;
  const out = { tags: [tag], alternatives: [] };
  if (tomorrowRec && tomorrowRec.kind === 'run') {
    out.run = tomorrowRec.run;
    out.forDate = tomorrow;
    out.reason = `${lead} Next up tomorrow: ${withDetail(tomorrowRec.run)}.`;
    out.alternatives = tomorrowRec.alternatives;
    if (tomorrowRec.tags.includes('Catch-up')) out.tags.push('Catch-up');
  } else if (tomorrowRec && tomorrowRec.kind === 'rest' && c.rolling && tomorrowRec.run && tomorrowRec.forDate) {
    out.run = tomorrowRec.run;
    out.forDate = tomorrowRec.forDate;
    out.reason = `${lead} Next up ${weekdayName(tomorrowRec.forDate)}: ${withDetail(tomorrowRec.run)}.`;
  } else if (tomorrowRec && tomorrowRec.kind === 'rest') {
    out.reason = `${lead} Tomorrow is a rest day too.`;
  } else {
    const left = remainingItems.length;
    out.reason = `${lead} ${left ? `${plural(left, 'planned run is', 'planned runs are')} still open${c.rolling ? '' : ' this week'}.` : ''}`.trim();
  }
  return result('rest', out);
}

/* ---------- race week ---------- */

function raceWeek(c, ctx, raceRun, result) {
  const { today, week, facts } = ctx;
  const raceDate = ctx.raceDate || week.endDate; // rolling mode: the person's own race date
  const toRace = daysBetween(today, raceDate);
  const raceName = `${weekdayName(raceDate)} ${shortDate(raceDate)}`;
  const shake = c.items.find(it => it.run.runType === 'shakeout');
  const easyLeft = ctx.remaining.filter(r => r.runType === 'easy');
  const tags = ['Race week'];

  if (toRace <= 0) {
    return result('run', {
      run: raceRun, forDate: today, tags: ['Race day'],
      reason: `It's race day: ${formatKm(raceRun.km)} km, worth ${pts(raceRun)} points. Start at your practised pace and fuel early.`,
      alternatives: []
    });
  }
  if (toRace === 1) {
    if (shake && !shake.done) {
      const sk = runView(shake.run, c.weekN);
      return result('run', {
        run: sk, forDate: today, tags: ['Race eve', 'Optional'],
        reason: `Race is tomorrow, so keep it light: ${sk.detail ? sk.detail.toLowerCase() : 'a short, easy jog'}, nothing hard.`,
        alternatives: []
      });
    }
    return result('rest', {
      run: raceRun, forDate: raceDate, tags: ['Race eve', 'Rest day'],
      reason: `Race is tomorrow: rest, hydrate and lay out your kit. ${formatKm(raceRun.km)} km on ${raceName}.`
    });
  }
  // Early in race week: easy only.
  if (easyLeft.length && !(facts.streak >= REST_AFTER_RUN_DAYS)) {
    const e = easyLeft[0];
    return result('run', {
      run: e, forDate: today, tags: [...tags, 'Easy day'],
      reason: `Race week means easy only: ${label(e)} keeps the legs fresh. The race is on ${raceName}, ${toRace} days away.`,
      alternatives: []
    });
  }
  return result('rest', {
    run: raceRun, forDate: raceDate, tags: [...tags, 'Rest day'],
    reason: `Race week: rest and let the legs recover. The ${formatKm(raceRun.km)} km race is on ${raceName}, ${toRace} days away.`
  });
}

/* ---------- plan lookups ---------- */

// First planned run (with a km goal) of a week for a person, as a run view.
function firstRun(weeks, n, person) {
  const w = weeks[n - 1];
  if (!w) return null;
  const r = w[person].runs.find(x => x.km > 0);
  return r ? runView(r, n) : null;
}

/* ---------- rolling mode: next up from the session queue ---------- */

const DAY_ABBR = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];

// Day preferences of a rolling plan (dow 1 = Monday ... 7 = Sunday). Without training days: Sat/Sun long, Tue-Thu quality (as today).
// With them: the long run belongs on the weekend training day(s), else on the last training day of the week; quality prefers
// training days between Tuesday and Thursday, else any training day that is not a long-run day.
function dayPreferences(trainingDays) {
  if (!trainingDays.length) return { isLongDay: dow => isWeekend(dow), isQualityDay: dow => dow >= 2 && dow <= 4 };
  const days = new Set(trainingDays.map(d => (d === 0 ? 7 : d)));
  const weekend = [...days].filter(isWeekend);
  const longDays = new Set(weekend.length ? weekend : [Math.max(...days)]);
  const mid = [...days].filter(d => d >= 2 && d <= 4);
  const other = [...days].filter(d => !longDays.has(d));
  const quality = new Set(mid.length ? mid : other.length ? other : [...days]);
  return { isLongDay: dow => longDays.has(dow), isQualityDay: dow => quality.has(dow) };
}

function decideRolling(c, depth) {
  const { today, person, rolling: R } = c;
  const { sessions, match, state, startDate, next } = R;
  const behindN = match.behind;
  const facts = loadFacts(c.mine, today);
  const summary = summarizeRolling(c);
  const feas = raceFeasibility({ sessions, match, personState: state, todayISO: today, ranToday: facts.ranToday, person });
  const calDaysLeft = daysBetween(today, addDays(mondayOf(today), 6)) + 1;
  const base = {
    weekNumber: next ? next.week : null, summary, plannedLeft: match.openCount, daysLeftInWeek: calDaysLeft,
    rolling: { behindSessions: behindN, openCount: match.openCount, doneCount: match.doneCount, totalCount: match.totalCount, nextSessionId: next ? next.id : null }
  };
  const nudge = r => {
    if ((r.kind !== 'run' && r.kind !== 'rest') || behindN < 2 || r.tags.some(t => t === 'Race day' || t === 'Race eve')) return r;
    const note = `You are ${plural(behindN, 'session', 'sessions')} behind plan pace, so try not to skip the next ones.`;
    return { ...r, tags: [...r.tags, 'Behind'], reason: /behind/i.test(r.reason) ? r.reason : `${r.reason} ${note}` };
  };
  const result = (kind, extra) => nudge({ kind, tags: [], alternatives: [], ...base, ...extra, ...(feas ? { raceFeasibility: feas } : {}) });

  /* --- before the start --- */
  if (today < startDate) {
    const firstS = sessions.find(s => !s.skipped && !s.optional);
    const first = firstS ? runView(firstS, firstS.week) : null;
    const inDays = daysBetween(today, startDate);
    const when = inDays === 1 ? 'tomorrow' : `on ${weekdayName(startDate)} ${shortDate(startDate)} (in ${inDays} days)`;
    return result('not-started', {
      reason: first ? `Your plan starts ${when}. Week ${firstS.week} opens with ${label(first)}.` : `Your plan starts ${when}.`,
      tags: ['Plan not started'], alternatives: first ? [{ run: first, why: 'First planned run' }] : [],
      plannedLeft: match.totalCount, daysLeftInWeek: 0, startsOn: startDate, startsInDays: inDays
    });
  }

  /* --- nothing left in the queue --- */
  if (!next) {
    const raceDone = sessions.some(s => s.runType === 'race' && match.bySession[s.id] && !match.bySession[s.id].partial);
    return result('done', {
      reason: raceDone
        ? `Race done: that is the whole plan finished. Be proud and rest well.`
        : match.totalCount
          ? `All ${match.totalCount} sessions of the plan are done. Enjoy the finish and keep running because you love it.`
          : 'There are no sessions left in your plan.',
      tags: ['Plan complete']
    });
  }

  const remainingItems = c.items.filter(it => !it.optional && !it.matched);

  /* --- on a break (a pause covers today): no run, no reminder --- */
  const pause = state.pauses.find(p => today >= p.from && today <= p.to);
  if (pause && !facts.ranToday) {
    const back = addDays(pause.to, 1);
    return result('rest', {
      tags: ['Paused', 'Rest day'], run: runView(next, next.week), forDate: back,
      reason: `Your plan is paused until ${weekdayName(pause.to)} ${shortDate(pause.to)}${pause.note ? ` (${pause.note})` : ''}. Back to it on ${weekdayName(back)} ${shortDate(back)}: ${withDetail(runView(next, next.week))}.`
    });
  }

  /* --- a run today already --- */
  if (facts.ranToday) return restWithTomorrow(c, base, result, 'You already ran today, so rest up.', 'Rest day', remainingItems, depth);

  const weekN = next.week;
  let remaining = remainingItems.map(it => runView(it.run, weekN));
  const prefs = dayPreferences(state.trainingDays);
  const dow = dowOf(today);

  /* --- the race --- */
  const raceRun = remaining.find(r => r.runType === 'race');
  if (raceRun) {
    const toRace = state.raceDate ? daysBetween(today, state.raceDate) : null;
    if (toRace !== null && toRace <= 7) {
      return raceWeek(c, { today, week: null, facts, remaining, raceDate: state.raceDate }, raceRun, result);
    }
    remaining = remaining.filter(r => r !== raceRun); // the race is not for today: the other open sessions come first
    if (!remaining.length) {
      if (toRace !== null) {
        return result('rest', {
          run: raceRun, forDate: state.raceDate, tags: ['Race ahead', 'Rest day'],
          reason: `Everything but the race is done. The ${formatKm(raceRun.km)} km race is on ${weekdayName(state.raceDate)} ${shortDate(state.raceDate)}, ${toRace} days away: keep the legs ticking over with easy runs if you like.`
        });
      }
      return result('run', {
        run: raceRun, forDate: today, tags: ['Race day'],
        reason: `All the training is done: the ${formatKm(raceRun.km)} km race (${pts(raceRun)} points) is all that is left. Pick your day, start at your practised pace and fuel early.`
      });
    }
  }

  /* --- not a training day --- */
  if (state.trainingDays.length && !state.trainingDays.includes(dow % 7)) {
    const names = state.trainingDays.map(d => DAY_ABBR[d]).join(', ');
    let nextDay = null;
    for (let i = 1; i <= 7 && !nextDay; i++) if (state.trainingDays.includes(dowOf(addDays(today, i)) % 7)) nextDay = addDays(today, i);
    const rec = nextDay && depth < 2 ? decide(resolve({ ...c, todayISO: nextDay }), depth + 1) : null;
    const lead = `Not a training day (you train on ${names}).`;
    if (rec && rec.run) {
      return result('rest', {
        run: rec.run, forDate: nextDay, tags: ['Rest day'], alternatives: rec.alternatives || [],
        reason: `${lead} Next up on ${weekdayName(nextDay)}: ${withDetail(rec.run)}.`
      });
    }
    return result('rest', { tags: ['Rest day'], reason: lead });
  }

  const behind = behindN >= 2;
  let nextLongDate = null;
  for (let i = 1; i <= 7 && !nextLongDate; i++) if (prefs.isLongDay(dowOf(addDays(today, i)))) nextLongDate = addDays(today, i);
  const ctx = {
    dow, today, week: null, weekN, daysLeft: calDaysLeft, remaining, weekendLeft: true, facts,
    behind, tight: false, longOpen: remaining.some(r => r.runType === 'long'),
    easeBack: facts.daysSince != null && facts.daysSince > EASE_BACK_AFTER_DAYS,
    rolling: true, behindSessions: behindN, nextLongDate, isLongDay: prefs.isLongDay, isQualityDay: prefs.isQualityDay
  };

  /* --- three run days in a row: rest unless behind --- */
  if (facts.streak >= REST_AFTER_RUN_DAYS && !behind) {
    return restWithTomorrow(c, base, result,
      `You have run ${facts.streak} days in a row, so take a rest day to absorb the training.`, 'Rest day', remainingItems, depth);
  }

  /* --- score the candidates --- */
  const scored = remaining.map((r, i) => assess(r, i, ctx)).sort((x, y) => (x.blocked - y.blocked) || (y.score - x.score) || (x.idx - y.idx));
  let pool = scored.filter(s => !s.blocked);
  // value first when behind, except after a long break: the ease-back rule (easy run first) keeps priority
  if (behind && !ctx.easeBack) pool = [...pool].sort((x, y) => (y.run.mult * (y.run.km || 0)) - (x.run.mult * (x.run.km || 0)) || x.idx - y.idx);
  const best = pool[0];

  if (!best) {
    const top = scored[0];
    return result('rest', {
      reason: `Rest today: ${lower(label(top.run))} is a hard effort and yesterday's ${facts.yType} still counts. A rest or easy day first, then it is safe.`,
      tags: ['Rest day', 'Recovery'], run: top.run, forDate: addDays(today, 1),
      alternatives: scored.slice(1, 3).map(altOf)
    });
  }
  if (!behind && best.score <= AVOID_SCORE) {
    const forDate = nextLongDate || addDays(today, 1);
    return result('rest', {
      reason: `Rest or a short, easy jog today. The ${formatKm(best.run.km)} km ${lower(best.run.type)} is best on ${weekdayName(forDate)}, when you have time and fresh legs.`,
      tags: ['Rest day', best.run.runType === 'long' ? 'Weekend long run' : 'Save it'],
      run: best.run, forDate,
      alternatives: scored.filter(s => s !== best).slice(0, 2).map(altOf)
    });
  }
  const alternatives = scored.filter(s => s !== best).slice(0, 2).map(altOf);
  const { reason, tags } = explain(best, ctx, pool);
  return result('run', { run: best.run, forDate: today, reason, tags, alternatives });
}
