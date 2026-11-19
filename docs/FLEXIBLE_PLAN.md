# Making the app less dependent on the fixed schedule

Status: proposal, nothing built yet. Decisions needed are in section 6.

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

A **calendar week (Monday to Sunday) counts** for a person when they logged at least their **weekly target** of runs (`sport: 'run'`, km > 0) in it. The weekly target defaults to the number of non-optional runs in their plan weeks (usually 3) and is editable per person (`weeklyTarget` in their plan state).

* **Streak** = number of consecutive counted weeks ending with the most recent *finished* week; the week in progress counts too once it is met, but never breaks the streak while it is still running.
* **Paused weeks** (inside a pause range, or covered by a pause) are skipped: they neither count nor break the streak.
* Weeks before the person's plan start are ignored. Also shown: the **best streak** ever.
* It is calendar-based on purpose: in a rolling plan nothing is "missed", so a plan-week streak could never break.
* The existing day streak (`streakDays`) stays as it is.
