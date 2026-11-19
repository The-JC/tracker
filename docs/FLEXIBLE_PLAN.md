# Making the app less dependent on the fixed schedule

Status: phases 1 to 3 built (sections 8 to 10); phase 4 (smarter next-up/reminders) is partly in (queue-based next-up, training days, pauses, race feasibility); phase 5 deferred. Sections 1 to 6 are the original proposal.

## 1. Where the app is tied to the schedule today

| # | Dependency | Where | Consequence |
|---|---|---|---|
| 1 | **Content is fixed**: 30 weeks x 2 people x ~3 runs hard-coded (type, detail, default km) | `src/plan.js` (`PLAN`, ~360 lines) | Only the km of a run can be changed (`goals` overrides). No way to change types, add/remove/reorder runs or use another plan length |
| 2 | **One calendar for everything**: a single `startDate`; plan week = `floor((date - start) / 7) + 1` | `scoring.js` `weekForDate`/`weekOfEntry`, used by `store`, `recommend`, `entryPatch`, the log form, and the reminder Worker | Illness, holidays or a late start cannot be absorbed: weeks keep ticking by |
| 3 | **Progress is "per calendar week"**: a week is *fulfilled* when run km >= planned km that week, otherwise *missed* for ever | `buildWeeks` | Falling behind is punished and invisible work (a long run done a week late) counts for nothing in the plan view |
| 4 | **Recommendation looks at the current calendar week only** | `recommend.js` (`weekN`, `daysLeftInWeek`) | Missed sessions are not carried forward; reminders inherit this |
| 5 | **No race date**: "race day" is just the last run of week 30 | `plan.js` | No "weeks left vs sessions left", no feasibility warning |
| 6 | **Both people share the same dates**: same start date, same weeks | `settings/startDate` | Cannot start at different times or pause independently |
| 7 | **No weekday preferences**: long run "prefers Sat/Sun", quality "Tue-Thu" are constants | `recommend.js` | Reminders ignore when each person actually trains |

What is already flexible and stays that way: points (from the actual run, not the plan), the activity log with free dates, the `week` override on imported entries, per-run km goals.

## 2. Principles

1. **Progress follows what you did, not the calendar.** The calendar still gives context (streaks, charts, reminders) but does not decide what is "missed".
2. **Life happens**: pause, skip, repeat or shift are explicit actions, not failures.
3. **Each person has their own position** in the plan.
4. **Nothing breaks**: existing data and the current behaviour stay available (calendar mode) and are the default for existing users.
5. **One shared pure module** for app and Worker (the pattern already used by `recommendForPerson.js`), with consistency tests.

## 3. Target model

**Sessions queue.** Flatten the plan into an ordered list of sessions (`w7-tempo`, ...). A person's progress is how many sessions are matched to their logged runs; **Next up = the first unmatched session**, wherever the calendar is. A "virtual week" is the group of sessions that share a week number, so the existing Plan tab (tiles, rings, %, status) keeps working: a week is `fulfilled` when its sessions are matched, `current` when it holds the next unmatched session, `upcoming` otherwise; "missed" becomes "N sessions behind".

**Per-person plan state** (new node `plans/<a|b>`, written by the app, read by the Worker):

```
{ mode: 'rolling' | 'calendar',      // calendar = today's behaviour, default for existing data
  startDate: 'YYYY-MM-DD' | null,    // overrides settings/startDate for this person
  raceDate:  'YYYY-MM-DD' | null,
  pauses:    [{ from, to, note? }],  // dates that don't count as behind (holiday, illness)
  skipped:   ['w7-speed', ...],      // sessions removed without penalty
  trainingDays: [2, 4, 6] }          // preferred weekdays, 0 = Sunday ... (used by reminders)
```

**Matching** (pure, deterministic, order-independent): runs sorted by date; each run takes the earliest unmatched session of the same run type among the next K (default 6) sessions; a run without a run type matches by closest km; unmatched runs stay "free runs" (they still earn points). A run can be pinned to a session by hand (`entry.session`) and the log form suggests the match ("Counts for: Tempo, Week 7", changeable). Editing or deleting a run simply re-runs the matching; week events stay deduplicated as today.

**Race date** (optional): shows sessions left vs weeks left, warns when it no longer fits, and offers to drop optional sessions (shakeouts) or shift.

## 4. Phases

| Phase | Content | Size | Risk |
|---|---|---|---|
| **P1 Foundation** | `src/planModel.js` with a single `weeksView(person, log, planState, today)` that returns the same shape as today's `buildWeeks`; calendar mode = current code, proven by golden tests against existing fixtures; route all consumers (`store`, `recommend`, `entryPatch`, log form, Worker) through it; move `PLAN` into a seedable template with the code as fallback | small-medium | low (no behaviour change) |
| **P2 Rolling engine** | session queue, matching, "sessions behind", virtual weeks, property tests (re-matching after edit/delete, ties, free runs, pauses) | medium | medium (matching ambiguity, mitigated by manual pin) |
| **P3 Controls and UI** | Plan tab and Settings: per-person start date, race date, pause range, skip a session, repeat a week, shift by N weeks, switch mode (with a preview of what changes); log form shows/pins the session a run counts for | medium | low-medium |
| **P4 Smarter next-up and reminders** | recommendation from the queue (not the calendar week), "you are 2 sessions behind" nudges, race-feasibility hints, reminders only on `trainingDays` and respecting pauses | medium | low (same module in Worker, consistency tests) |
| **P5 Plan editor** (optional) | edit type/km/detail per session, add/remove/reorder, pick a template length, copy one person's plan to the other; completed sessions frozen | large | medium |

Rollout: existing users stay in calendar mode; the app offers "Switch to a flexible plan" once P3 is live. Deploy order: Worker before app (as today), export a JSON backup of the database before enabling anything that writes `plans/`.

## 5. Lite option (about 40% of the work, most of the benefit)

P1 + pause/shift + per-person start date + race date + training days for reminders. Keeps the calendar-week model, adds the ability to move or pause it. Choose this if you want predictability over flexibility.

## 6. Decisions needed

1. **Model**: rolling sessions queue (recommended) or Lite (calendar plus pause/shift)?
2. **Independence**: separate start date / plan state per person (recommended)? If so, is comparing "plan %" between you two still wanted, or should the scoreboard compare points/km only?
3. **Race date**: add it (recommended), or keep "week 30 = race"?
4. **Training days**: set preferred weekdays per person, used for reminders and long-run placement?
5. **Plan editor (P5)**: needed now, later, or never (km edits are enough)?
6. **Default for you two**: switch straight to the flexible mode when it is ready, or stay in calendar mode until you choose?

## 7. Decisions taken

| # | Decision |
|---|---|
| 1 | **Full rolling model** (phases P1 to P4). |
| 2 | **Per-person plan state**: own start date, race date, pauses, skips, training days. The scoreboard compares points and km; "plan %" is shown per person against their own plan. |
| 3 | **Race date**: yes (optional field per person). |
| 4 | **Training days**: included in P4 (reminders and long-run placement follow them). Default when unset: today's constants. |
| 5 | **Plan editor (P5)**: deferred; revisit after P4. |
| 6 | **Rollout**: existing data stays in calendar mode; the app offers the switch to the flexible plan once P3 is live. |
| 7 | **Week streak is kept** (see below). |

### Week streak (definition)

A **calendar week (Monday to Sunday) counts** for a person when they logged at least their **weekly target** of runs (`sport: 'run'`, km > 0) in it. The weekly target defaults to the number of non-optional runs in their plan weeks (usually 3) and is editable per person (`weeklyTarget` in their plan state). The target is **per week**: for a calendar week that maps to a plan week it is capped by the non-optional runs planned in that plan week (so the race week, with two, needs two); weeks outside the plan use the configured target.

* **Streak** = number of consecutive counted weeks ending with the most recent *finished* week; the week in progress counts too once it is met, but never breaks the streak while it is still running.
* **Paused weeks** (inside a pause range, or covered by a pause) are skipped: they neither count nor break the streak.
* Weeks before the person's plan start are ignored. Also shown: the **best streak** ever.
* It is calendar-based on purpose: in a rolling plan nothing is "missed", so a plan-week streak could never break.
* The existing day streak (`streakDays`) stays as it is.

## 8. Phase 1 API (implemented: per-person plan state, week streak)

Phase 1 changes no behaviour for existing data: with no `plans` node every person gets the defaults (calendar mode, start = `settings/startDate`, else the automatic rule). Phases 2 and 3 code against the names below.

### Database
`trailhead-tracker-v1/plans/<a|b>` = `{ mode?, startDate?, raceDate?, pauses?, skipped?, trainingDays?, weeklyTarget? }` (only set fields exist; cleared fields are removed). Each person writes only their own node (store enforces it; the rules allow both, as for everything under the root). The Worker reads the whole `plans` node (one GET, failures are ignored = defaults). The legacy `settings/startDate` stays the fallback start of both people; phase 3 moves its UI to per person.

### `src/planModel.js` (pure; app, Worker and node tests)
| Export | Semantics |
|---|---|
| `DEFAULT_PLAN_STATE` | frozen `{ mode:'calendar', startDate:null, raceDate:null, pauses:[], skipped:[], trainingDays:[], weeklyTarget:null, fallbackStartDate:null }` |
| `normalizePlanState(raw, { settingsStartDate })` | the `plans` node -> `{ a: PlanState, b: PlanState }`. Invalid fields dropped, never throws, idempotent. `startDate` = the person's OWN start only; `settingsStartDate` (valid ISO) is added as `fallbackStartDate` (never stored in the DB). `pauses`: `{from,to,note?}` valid, `from<=to`, sorted, overlapping merged (adjacent kept separate); `skipped`: unique non-empty strings; `trainingDays`: unique ints 0 (Sunday)..6, ascending; `weeklyTarget`: int 1..14 or null; `mode`: 'calendar' (default) or 'rolling' |
| `normalizePersonState(raw, { settingsStartDate })` | the same for one person's node |
| `validatePlanPatch(patch)` | strict check of user input: `{ ok:true, patch }` (provided fields only, normalised; `null` clears, arrays -> `[]`) or `{ ok:false, error }` (user-facing message) |
| `effectiveStartFor(person, state, log, todayISO)` | own `startDate`, else `fallbackStartDate`, else automatic rule (Monday of the earliest dated run of the WHOLE log, else this Monday; identical to `scoring.effectiveStartDate`) |
| `weekOfEntryFor(person, entry, state, log, todayISO)` | `scoring.weekOfEntry` with that person's start; `entry.week` override wins; may be <1 or >plan length |
| `buildWeeksFor({ plan, goals, log, state, todayISO, viewer='a' })` | same shape as `scoring.buildWeeks`; `a` evaluated against a's start, `b` against b's (composes `buildWeeks` once per person). Top-level `n/kind/tag/current/startDate/endDate` follow `viewer`. With equal starts it is deep-equal to `buildWeeks` (golden tests) |
| `weekWindowsFor({ plan, log, state, todayISO })` | `{ a:[{n,startDate,endDate,current,over}], b:[...] }`: each person's own calendar of the plan weeks |
| `currentWeekIndexFor(windows, person)` | index of the current plan week or null |
| `isPaused(state, dateISO, person?)`, `pausedDaysInWeek(state, mondayISO, person?)`, `weekIsPaused(state, mondayISO, person?)` | pause lookups. `state` may be `{a,b}` (then pass `person`) or one person's state. A week is paused when all 7 days are inside pauses |
| `getPlanTemplate(id='default')` | the `PLAN` constant (database templates: phase 5) |
| `defaultWeeklyTarget(plan, person?)`, `weeklyTargetFor(person, state, plan)` | mode of "runs with km > 0 per plan week" (3 here); `state.weeklyTarget` wins |
| `weekStreak({ log, person, state, plan, todayISO })` | `{ current, best, thisWeek:{ runs, target, met, paused }, target }`, rules below |
| `PERSONS`, `PLAN_MODES`, `PLAN_FIELDS`, limits (`MAX_PAUSES`...) | constants |

All helpers accept `{a,b}` states, one person's state or the raw stored node (they normalise on the fly); `state` undefined = defaults.

Week streak, as implemented (§7 plus): weeks are Monday-Sunday; the week containing the person's start is the first one; undated imports use `week` -> Monday of `start + (week-1)*7`; runs dated after today are ignored; a week fully inside pauses is skipped; a partly paused week counts when met and is skipped (not broken) when not met; the week in progress counts once met and never breaks. The target is per week: `min(weeklyTarget ?? default, non-optional planned runs of the plan week)` for a calendar week that maps to a plan week of the person (calendar mode only; plan week = the one containing the week's Thursday, first week clamped to the start; planned = goal km > 0 after `goals` overrides, minus `skipped` entries given as run id or `w<week>-<runType>`; 0 planned = configured target). Weeks outside the plan and rolling mode use the configured/default target. So exactly doing the plan (race week: 2 runs) never loses the streak. `weekStreak` takes an optional `goals`; top-level `target` is the configured/default one, `thisWeek.target` is the current week's.

### Consumers (all go through planModel)
* `recommendForPerson({ person, log, goals, startDateSetting, planState, todayISO })`: `planState` = the raw `plans` node or the app's `store.plans`; absent = old behaviour. Returned `weeks` have `person` as viewer. `recommendNext` accepts `planState` (and still `startDate`/`weeks`).
* `entryPatch.weekFulfillment` / `newlyFulfilledWeek` accept `planState` (+ `settingsStartDate`).
* Worker `recommendationFromDb` reads `plans` and passes it as `planState`.
* Store: `store.plans`, `planStates`, `effectiveStartForPerson(person)`, `effectiveStartDate` (signed-in person), `weeks` (per-person), `weekWindows`, `weekStreaks`, `setPlanState(person, patch)`; see REBUILD_PLAN §6.
* `viewmodels.thisWeekSummary(weeks, stats, windows?)` uses each person's own current plan week when `windows` is given; `weekStreakText`, `thisWeekRunsText`.

Notes for phases 2 and 3 (historical: from phase 2 on, `mode: 'rolling'` is read everywhere, see §9): A person's weeks in `weeks[i].a/.b` are per person, the top-level date fields are not: read per-person dates from `weekWindows`. The Plan tab detail still shows the signed-in person's dates in its header.

## 9. Phase 2 API (implemented: rolling engine)

Phase 2 makes `mode: 'rolling'` real. Calendar mode is untouched (same code path, golden tests unchanged); a person is rolling when their own plan state says so, so one person can be rolling while the other stays on the calendar. Everything is pure and shared by app, Worker and tests. `src/rolling.js` and `src/planModel.js` import each other but only use the other's exports inside functions, so the cycle is harmless (the Worker still bundles; no Vue/DOM imports).

### New stored fields
* `plans/<p>/repeatWeeks: number[]`: plan weeks (1..plan length) that are done once more right after the original week. `normalizePersonState` sorts, dedupes and drops invalid values (default `[]`); `validatePlanPatch` accepts it (strict, `null` clears); `DEFAULT_PLAN_STATE.repeatWeeks = []`; `PLAN_FIELDS` includes it.
* `log/<id>/session: string` (optional): the plan session a run is pinned to (a session id, see below). Added by the log form / edit; the engine ignores it when the session does not exist, is skipped, or is already pinned by an earlier run.

### Sessions (`src/rolling.js`)
`buildSessions(plan, goals, personState, person = 'a')` (also `buildSessions({ plan, goals, state, person })`; `personState` may be one person's state, `{a,b}` together with `person`, or the raw node) returns the ordered queue
`[{ id, week, index, runId, runType, type, detail, km, mult, optional, skipped, repeat }]`:
* `id` is the plan run id (`'1-7-1-a'`); the second pass of a repeated week appends `~r2` (`'1-7-1-a~r2'`) and comes right after the original week. `runId` is always the original run id; goals (km overrides) are keyed by it.
* `km` is the effective goal; `optional` = `km <= 0` (race-week shakeout). `index` is the position in the returned list (skipped sessions included, so it is stable).
* `skipped`: `state.skipped` holds run ids or `w<week>-<runType>` aliases (repeat pass: `...~r2`). Skipped sessions stay in the list (so the UI can show them) but are never matched, open or counted: every consumer filters them.
* `sessionLabel(session)` -> `'Tempo · Week 7'` (`'... (repeat)'`).

### Matching
`matchRuns({ sessions, entries, personState, todayISO, lookahead = 6, startDate?, person? })` -> `{ bySession: { [sessionId]: { entryId, km, partial } }, byEntry: { [entryId]: { sessionId, week, partial, pinned } }, free: [entryId], firstOpenIndex, doneCount, partialCount, openCount, totalCount, behind, lookahead }`. Plain objects (serialisable). Only the person's runs (`sport 'run'`, `km > 0`) count; with `person` other people's entries are dropped.
Rules, in this order (each run takes at most one session, each session at most one run; ties by `(date, ts, id)`, so the result does not depend on the order of `entries`):
1. **Pins**: `entry.session` names an existing, non-skipped, still free session.
2. **Week overrides** (`entry.week`, i.e. undated imports): the first free session of that plan week with the same run type, else the free session of that week with the closest km, else free.
3. **Dated runs**, oldest first: a run with a known run type takes the **earliest free session of the same run type among the next `lookahead` free sessions**; a run with no/unknown run type takes the one among them with the closest km. Nothing fits: the run stays free (`free`; it still earns points).
A run is **done** for its session at `>= DONE_THRESHOLD` (0.9, shared with `recommend.js`) of its km, a shorter run is **partial**: it still consumes the session (the queue moves on) but is flagged. Optional sessions are never partial. `firstOpenIndex` = index in `sessions` of the first unmatched, non-optional, non-skipped session (-1: none); `doneCount` = matched non-partial, `partialCount`, `openCount` = unmatched, `totalCount` = non-skipped non-optional sessions. `behind` = `behindSessions(...)` when a start date is known (argument, else `personState.startDate/fallbackStartDate`), else 0.
Editing/deleting a run just re-runs the matching: runs before it in `(date, ts, id)` order keep their sessions; editing only the km of a typed run changes only that session's `partial` flag.
Helpers: `nextOpenSession(sessions, match)`, `explainMatch(entryId, match, sessions)` -> `'Counts for Tempo, Week 7'` (`' (partly)'`, `' (repeat)'`) or `'Free run'`, `suggestSession({ person, draft: { runType, km, date, id?, session? }, sessions, match, entries?, personState?, todayISO?, lookahead? })` -> `{ sessionId, week, label: 'Tempo · Week 7', alreadyMatched?: true } | null`. With `entries` (the person's activities) it re-runs the matching with the draft added (exact for any date; `draft.id` = the entry being edited, which is replaced); without them the draft is treated as the newest run and takes the free sessions left in `match`. `draft.session` (explicit pin) returns that session, `alreadyMatched` true when another run holds it (the pin would be ignored); `alreadyMatched` is also true when the edited run is already matched to the suggested session. A skipped/unknown pinned session gives `null`.

### Pace: `behindSessions`
`sessionsDue({ sessions, personState, startDate, todayISO })` -> `{ due, total, basis: 'race' | 'calendar' | 'none' }` and `behindSessions({ sessions, match, personState, startDate, todayISO })` = `max(0, due - (doneCount + partialCount))`. `total` = non-skipped, non-optional sessions. Pace:
* **With a race date after the start**: the `total` sessions are spread evenly over the not-paused days from the start to the race date: `sessionsPerDay = total / availableDays` (`availableDays` = days in `[start, race)` minus paused days); `due = floor(total * elapsed / availableDays)` where `elapsed` counts the not-paused days strictly before today (capped at the race). The race session is never due before the race date (`due <= total - 1` until then); after it everything is due.
* **Without a race date** (or a race date on/before the start): the plan's own calendar. Plan week `n` starts `start + 7 (n - 1)`; all sessions of a week are due once that week has completely passed, and **paused days do not count as elapsed**, so a pause shifts every later week. `blocks = floor(elapsedNotPausedDays / 7)` and the first `blocks` week groups are due; a repeated week is one more group (its repeat pass), a week with all sessions skipped still takes its calendar week.
* Before the start, with no start date, or nothing planned: 0. Dates are compared as calendar days (UTC based), so DST changes never matter.
`raceFeasibility({ sessions, match, personState, todayISO, ranToday? })` -> `{ daysLeft, sessionsLeft, slots, fits, shortBy, raceDate } | null` (null without a valid race date): `sessionsLeft` = open non-optional sessions (race included); `slots` = training days from today (tomorrow if `ranToday`) before the race that are not paused (`trainingDays` weekdays when set, else `floor(days * 3 / 7)`), plus one for the race day itself; `fits = slots >= sessionsLeft`, `shortBy = max(0, sessionsLeft - slots)`; a past race date gives `daysLeft 0`, no slots.

### Rolling week view: `buildWeeksFor`
For a person in rolling mode `buildWeeksFor` replaces that person's `a`/`b` values by `rollingWeeksFor({ plan, goals, log, person, state, startDate, todayISO })` -> `{ weeks, currentIndex, sessions, match, behindSessions, nextSession }`; `rollingStateFor(...)` -> `{ sessions, match, state, startDate }` gives just the queue. Per plan week the person value has the Phase-1 shape plus extras:
`{ plannedKm, doneKm, pct, status, runs, entries, behindSessions, sessionsDone, sessionsTotal, partialCount, repeated }`
* `runs`: one per session of that week (a repeated week lists its repeat pass too, ids with `~r2`): `{ id, runId, type, runType, detail, mult, km, defaultKm, skipped, repeat, matched: { entryId, km, partial } | null }`.
* `plannedKm` = km of the sessions that are not skipped (repeat pass included); `doneKm` = km of the runs matched to them; `entries` = those runs' activities (free runs belong to no week).
* `status`: `'fulfilled'` when every non-optional, non-skipped session of the week is matched (partial counts as matched), `'current'` for the week holding the first open session, `'upcoming'` otherwise, `'n/a'` when nothing is planned (e.g. everything skipped). **Never `'missed'`.** `pct` is 100 for a fulfilled week without partial runs, else `min(99, round(100 * doneKm / plannedKm))`, null when nothing is planned.
* `behindSessions` is the person's value (same on every week); `sessionsDone`/`sessionsTotal` count matched / required sessions of the week.
* Top-level `n/kind/tag/startDate/endDate` follow the viewer's calendar as in Phase 1; top-level `current` follows the **viewer's queue** (the week of their first open session) when the viewer is rolling, their calendar week otherwise. `weekWindowsFor` stays calendar for everyone. Scoreboard, week streak (calendar based, pauses respected) and the other consumers keep working unchanged.

### Next up from the queue
`recommendNext` / `recommendForPerson` use the queue when `planState.mode === 'rolling'` (calendar results are identical, proven by consistency tests). The candidate pool is the open sessions of the week group (plan week + repeat pass) holding the first open session. All existing rules apply (no hard after hard/long, recovery easy, quality days, weekend long run, ease back in, rest after a run today / three run days in a row, race eve/day) with these changes:
* `summary` / `weekNumber` / `plannedLeft` describe that group and the queue (`plannedLeft` = all open sessions); `daysLeftInWeek` = days left in the calendar week. Extra result field `rolling: { behindSessions, openCount, doneCount, totalCount, nextSessionId }` (absent in calendar mode).
* **Training days** are preferences: when set and today is not one, `kind: 'rest'`, `run` = the best session on the next training day, `forDate` = that day, tag `Rest day`. The long run goes to the weekend training day(s) (else the last training day of the week); quality prefers training days Tue-Thu (else any training day that is not a long-run day). Unset: today's constants (Sat/Sun long, Tue-Thu quality).
* **Behind**: when `behindSessions >= 2` the reason says so ("You are N sessions behind plan pace...") and the tag `Behind` is added to `run`/`rest` results (not on race eve/day). Catch-up ordering (most valuable safe run first) applies while behind, except after a long break where the ease-back rule keeps priority.
* **Race**: with a race date within 7 days and the race session open, the race-week rules run on that date; farther away the race is left out of the pool (only the race left: `rest` with tag `Race ahead`, next up on the race date). Without a race date, a race session that is the only one open is recommended as `run` with tag `Race day`.
* **Race feasibility**: when a race date is set the result carries `raceFeasibility` (`raceFeasibility()` above).
* Queue exhausted: `kind: 'done'`, tag `Plan complete`; before the start: `'not-started'` as before. Reminders (Worker) go out only for `kind: 'run'`, so non-training days send nothing.

### Pure plan operations (patches for `setPlanState`; never mutate; invalid input throws an `Error` with a user-facing message)
`skipSessionPatch(state, sessionId)` -> `{ skipped }` (id or `w7-tempo` alias, idempotent), `unskipSessionPatch(state, sessionId)` (removes the id and its alias), `repeatWeekPatch(state, week)` / `unrepeatWeekPatch(state, week)` -> `{ repeatWeeks }`, `addPausePatch(state, { from, to, note? })` -> `{ pauses }` (merged, sorted), `removePausePatch(state, index)`. `state` = one person's plan state (store passes `store.plans[me]`).
`previewModeSwitch({ plan, goals, log, state, todayISO, person = 'a' })` -> `{ calendar: { currentWeek, fulfilledWeeks, behind }, rolling: { currentWeek, fulfilledWeeks, nextSession } }`: both modes are always evaluated whatever `state.mode` is; `calendar.behind` = weeks already missed under the calendar rules; `rolling.nextSession` = first open session or null; `currentWeek` = plan week number or null.

### Notes
* Free runs (matched to nothing) still count for points, streaks and totals; `week` events in rolling mode follow the week of the session (UI: `entryPatch.rollingNewlyFulfilledWeek`).
* Partial counts as matched for week status and pace but not as done (`doneCount`, `pct`).
* Tests: `tests/rolling.test.mjs` (sessions, matching incl. seeded property tests, pace incl. DST and pauses, week view, patches, suggestion), `tests/recommendRolling.test.mjs` (18 next-up scenarios, calendar consistency), `worker/tests/reminders.test.js`.

## 10. Phase 3 and QA notes (final behaviour)

* **UI**: Settings, **My plan** (`PlanSettings.vue`): mode (with a preview of what changes), start date, race date (must be after the start), weekly target, training days, pauses (quick "pause until" and a range with a note, notes are rendered as text), skipped/repeated list. The Plan tab header shows weeks/sessions left, "behind by N sessions" and a "Pause my plan" shortcut; an open week offers "Skip this session" and "Repeat this week" (own runs, flexible mode only). A one-time banner (per device) offers the flexible plan to people on fixed weeks. Settings only links to My plan (the start date moved there).
* **Free run pin**: `log/<id>/session = 'free'` means "never match this run to a session"; the log form's select has "Free run (no session)". The engine leaves such runs in `free` (they still earn points, streaks and totals); `scoring.cleanSessionId` accepts it; `scoring.sessionPinAllowed(session, person)` is the cross-person guard (a person may pin only to their own plan's session ids or `'free'`; the store and `entryPatch.prepareEdit` drop foreign pins).
* **Week events**: in flexible mode the 'week fulfilled' event follows the plan week of the session (`rollingNewlyFulfilledWeek`, evaluated for any sport on edit because removing a run can re-shuffle the matches). `addActivity` and `updateActivity` both skip the event when the person already has one for that week (`hasWeekEvent`), so delete-and-relog does not duplicate it. Edits that do not newly fulfil a week emit nothing.
* **Pauses and Next up**: in flexible mode a day inside a pause gives `kind: 'rest'`, tags `Paused`/`Rest day`, `forDate` = the day after the pause, so no reminder is sent. Fixed (calendar) mode ignores pauses there (only the week streak and the pace in flexible mode use them).
* **Mode switching** never rewrites logs: calendar and flexible are two views of the same log. `plans/<p>` keeps skips, repeats, pauses, race date and training days when you switch back.
* **Cross-person boundary**: `setPlanState` and all plan actions throw unless `person === store.me`. The database rules (template, untouched) still allow both accounts to write the whole root, so this is enforced by the client only; the Worker never writes `plans`.
* **Tests**: `tests/flexibleQa.test.mjs` (free pin, pins across persons, matching edge cases, week events, DST 2026-03-29 and 2026-10-25, pauses across week borders, race date today/past/before start, streak with pauses in both modes, pause in Next up) and two more cases in `worker/tests/reminders.test.js`.
