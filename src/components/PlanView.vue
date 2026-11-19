<script setup>
// PlanView: overview of the 30 plan weeks (read-only status; runs are logged through the + sheet).
// Props: none. Emits: none. Lazy-loaded by App.vue. Reads weeks, scoreboard, effectiveStartDate, store.*;
// calls setGoal(runId, kmString) (debounced; '' resets to the plan default), setPlanState(me, { startDate }) and, for the
// signed-in person's own runs in a flexible plan, skipSession / unskipSession / repeatWeek / unrepeatWeek (store.js).
// Emits: 'plan-settings' (optional section name: opens the My plan sheet, see App.vue).
import { ref, reactive, computed, onMounted, onBeforeUnmount, nextTick } from 'vue';
import {
  store, today, weeks, scoreboard, effectiveStartDate, planStates, setGoal, setPlanState, pushToast,
  skipSession, unskipSession, repeatWeek, unrepeatWeek
} from '../store.js';
import { SPORT_BY_KEY, TOTAL_WEEKS } from '../plan.js';
import { formatKm, formatPoints, pointsFor, relativeDate, formatDateLong } from '../scoring.js';
import { PERSONS, fulfilledCount, tilePct, tileLabel, detailAnchor, shortDate } from '../viewmodels.js';
import { tileStatusFor, weekStatusText, totalBehind, behindText, isFlexible, shouldShowFlexBanner, dismissFlexBanner } from '../utils/planViewModel.js';
import { sessionsLeft, planHeaderText, activePause } from '../utils/planSettingsForm.js';

const emit = defineEmits(['plan-settings']);

const STATUS_WORD = { fulfilled: 'fulfilled', current: 'current week', missed: 'missed', upcoming: 'upcoming' };

/* ---- the viewer's own plan: header, mode, pause ---- */
const me = computed(() => store.me);
const mine = computed(() => (me.value ? planStates.value[me.value] : null));
const modes = computed(() => ({ a: planStates.value.a.mode, b: planStates.value.b.mode }));
const flexible = computed(() => isFlexible(mine.value));
const anyCalendar = computed(() => PERSONS.some(p => modes.value[p] === 'calendar'));
// A flexible viewer never sees a tile styled as missed (the other person's own week text still says what it says).
const tileModes = computed(() => (flexible.value ? { a: 'rolling', b: 'rolling' } : modes.value));
const status = w => tileStatusFor(w, tileModes.value);
const headerLine = computed(() => (mine.value && me.value
  ? planHeaderText({ todayISO: today.value, raceISO: mine.value.raceDate, sessions: sessionsLeft(weeks.value, me.value) })
  : ''));
const behindLine = computed(() => (flexible.value && me.value ? behindText(totalBehind(weeks.value, me.value)) : ''));
const pausedNow = computed(() => (mine.value ? activePause(mine.value.pauses, today.value) : null));
const openPlan = section => emit('plan-settings', section);

/* ---- one-time banner for people still on fixed weeks ---- */
const safeStorage = () => { try { return localStorage; } catch (e) { return null; } };
const bannerDismissed = ref(!shouldShowFlexBanner({ mode: 'calendar' }, safeStorage())); // localStorage flag, per device
const showFlexBanner = computed(() => !bannerDismissed.value && !!mine.value && mine.value.mode === 'calendar' && store.logLoaded);
function dismissBanner() { bannerDismissed.value = true; dismissFlexBanner(safeStorage()); }
function tryFlexible() { dismissBanner(); openPlan('mode'); }

/* ---- headline per person ---- */
const headline = computed(() => Object.fromEntries(PERSONS.map(p => [p, { weeks: fulfilledCount(weeks.value, p), pct: scoreboard.value[p].planPct }])));

/* ---- start-date banner ---- */
const needsStart = computed(() => !store.settings.startDate && !(store.me && planStates.value[store.me].startDate) && !store.log.some(e => e.sport === 'run' && e.date));
const startDraft = ref('');
const startError = ref('');
async function saveStart() {
  startError.value = '';
  if (!startDraft.value) { startError.value = 'Pick a date first.'; return; }
  try { await setPlanState(store.me, { startDate: startDraft.value }); } catch (e) { startError.value = e.message || 'Invalid date.'; }
}

/* ---- own runs in a flexible plan: skip a session, repeat a week (and undo) ---- */
const busyKey = ref('');
async function act(key, fn, failText) {
  if (busyKey.value) return;
  busyKey.value = key;
  try { await fn(); } catch (e) { pushToast((e && e.message) || failText, 'danger'); }
  busyKey.value = '';
}
const canAct = p => p === store.me && flexible.value;
// In a flexible plan the runs of a week are its sessions: run.id is the session id ('1-7-1-a', '...~r2' for a repeat pass).
const skipRun = run => act(`skip-${run.id}`, () => skipSession(run.id), "Couldn't skip that session.");
const unskipRun = run => act(`skip-${run.id}`, () => unskipSession(run.id), "Couldn't undo the skip.");
const weekRepeated = w => !!mine.value && mine.value.repeatWeeks.includes(w.n);
const repeatThisWeek = w => act(`repeat-${w.n}`, () => repeatWeek(w.n), "Couldn't repeat that week.");
const undoRepeat = w => act(`repeat-${w.n}`, () => unrepeatWeek(w.n), "Couldn't undo the repeat.");

/* ---- grid + expanded week ---- */
const open = ref(null); // week number (1-based) or null
const mq = typeof window !== 'undefined' && window.matchMedia ? window.matchMedia('(min-width: 640px)') : null;
const cols = ref(mq && mq.matches ? 4 : 3);
const onMq = () => { cols.value = mq.matches ? 4 : 3; };
const openIndex = computed(() => (open.value ? weeks.value.findIndex(w => w.n === open.value) : -1));
const anchor = computed(() => detailAnchor(openIndex.value, cols.value, weeks.value.length));
const openWeek = computed(() => (openIndex.value >= 0 ? weeks.value[openIndex.value] : null));
const toggle = n => { open.value = open.value === n ? null : n; };

const tileLabelText = w => {
  const st = status(w);
  const people = PERSONS.map(p => `${store.names[p]} ${w[p].pct == null ? 'no plan' : `${w[p].pct} percent`}`).join(', ');
  return `Week ${w.n}${w.tag ? `, ${w.tag}` : ''}, ${STATUS_WORD[st.key]}, ${people}`;
};

/* ---- per-run km goals (debounced) ---- */
const drafts = reactive({});
const errors = reactive({});
const timers = {};
const shownKm = run => (drafts[run.id] !== undefined ? drafts[run.id] : formatKm(run.km));
const goalId = run => run.runId || run.id; // goals are keyed by the plan run id, also for a repeat pass
const isOverridden = run => String(store.goals[goalId(run)] ?? '').trim() !== '';

function onGoalInput(run, ev) {
  drafts[run.id] = ev.target.value;
  clearTimeout(timers[run.id]);
  timers[run.id] = setTimeout(() => commitGoal(run), 600);
}
async function commitGoal(run, reset = false) {
  clearTimeout(timers[run.id]);
  let v = reset ? '' : drafts[run.id];
  if (v === undefined) return;
  const n = parseFloat(String(v).replace(',', '.'));
  if (v.trim() !== '' && n === run.defaultKm) v = ''; // same as the plan default: drop the override
  try {
    await setGoal(goalId(run), v);
    delete errors[run.id];
    delete drafts[run.id];
  } catch (e) {
    errors[run.id] = e.message || 'Not a valid distance.';
  }
}

/* ---- logged activities of a week ---- */
const entryMeta = e => {
  const sport = SPORT_BY_KEY[e.sport];
  const amount = sport && sport.requires === 'km' ? `${formatKm(e.km)} km` : e.durationMin ? `${formatKm(e.durationMin)} min` : '';
  return [amount, `${formatPoints(pointsFor(e))} pts`].filter(Boolean).join(' · ');
};
const entryWhen = e => (e.date ? relativeDate(e.date) : 'Imported');

/* ---- scroll the current week into view on first show ---- */
const root = ref(null);
onMounted(() => {
  if (mq) mq.addEventListener('change', onMq);
  nextTick(() => requestAnimationFrame(() => requestAnimationFrame(() => {
    const el = root.value && root.value.querySelector('[data-current]');
    if (el) el.scrollIntoView({ block: 'center' });
  })));
});
onBeforeUnmount(() => { if (mq) mq.removeEventListener('change', onMq); });
</script>

<template>
  <section ref="root" class="plan-view stack stack--lg" aria-label="Plan">
    <div class="card stack">
      <div class="section-header">
        <h2 class="section-title">{{ TOTAL_WEEKS }}-week plan</h2>
        <span class="text-sm text-muted">Week 1 starts {{ shortDate(effectiveStartDate) }}</span>
      </div>
      <div v-if="mine" class="stack stack--sm">
        <p v-if="headerLine" class="plan-head__sub"><strong class="text-strong">Your plan:</strong> {{ headerLine }}</p>
        <div class="row row--sm row--wrap">
          <span v-if="flexible" class="tag tag--accent">Flexible plan</span>
          <span v-if="behindLine" class="plan-behind">You are {{ behindLine }}. Nothing is lost: your next session is waiting.</span>
          <span v-if="pausedNow" class="tag">Paused until {{ shortDate(pausedNow.to) }}</span>
        </div>
        <div class="plan-actions">
          <button type="button" class="btn btn--secondary btn--sm" @click="openPlan('')">My plan</button>
          <button type="button" class="btn btn--secondary btn--sm" @click="openPlan('pauses')">Pause my plan…</button>
        </div>
      </div>
      <div class="grid">
        <div v-for="p in PERSONS" :key="p" class="stack stack--sm">
          <div class="row row--sm text-sm text-semibold"><span class="dot" :class="`dot--${p}`"></span><span class="truncate">{{ store.names[p] }}</span></div>
          <div class="stat stat--lg" :class="`stat--${p}`">
            <span class="stat__value">{{ headline[p].weeks }}<span class="stat__unit">of {{ TOTAL_WEEKS }}</span></span>
            <span class="stat__label">weeks fulfilled</span>
          </div>
          <div class="progress progress--sm" :class="`progress--${p}`" role="progressbar" :aria-valuenow="headline[p].pct" aria-valuemin="0" aria-valuemax="100" :aria-label="`${store.names[p]}: ${headline[p].pct}% of planned km`" :style="{ '--value': headline[p].pct }">
            <div class="progress__bar"></div>
          </div>
          <span class="text-xs text-muted">{{ headline[p].pct }}% of planned km</span>
        </div>
      </div>
    </div>

    <div v-if="showFlexBanner" class="banner" role="status">
      <span class="banner__icon"><svg class="icon" aria-hidden="true"><use href="#i-info" /></svg></span>
      <div class="banner__body">
        <div class="banner__title">Behind on your plan? Try the flexible plan</div>
        <div class="banner__text">It follows your progress instead of the calendar: weeks never count as missed, and you can skip a session or repeat a week.</div>
        <div class="plan-actions">
          <button type="button" class="btn btn--primary btn--sm" @click="tryFlexible">See how it works</button>
          <button type="button" class="btn btn--ghost btn--sm" @click="dismissBanner">Not now</button>
        </div>
      </div>
    </div>

    <div v-if="needsStart" class="banner" role="status">
      <span class="banner__icon"><svg class="icon" aria-hidden="true"><use href="#i-info" /></svg></span>
      <div class="banner__body">
        <div class="banner__title">Set the plan start date</div>
        <div class="banner__text">Weeks are counted from this date. Until you set it, week 1 starts on the Monday of this week ({{ formatDateLong(effectiveStartDate) }}).</div>
        <div class="plan-start">
          <label class="sr-only" for="plan-start-date">Plan start date</label>
          <input id="plan-start-date" v-model="startDraft" class="input" type="date" :aria-invalid="startError ? 'true' : null">
          <button type="button" class="btn btn--primary btn--sm" @click="saveStart">Set start date</button>
        </div>
        <p v-if="startError" class="field__error" role="alert">{{ startError }}</p>
      </div>
    </div>

    <div class="stack stack--sm">
      <div class="legend" aria-label="Legend">
        <span class="legend__item"><span aria-hidden="true">✓</span> Fulfilled</span>
        <span class="legend__item"><span aria-hidden="true">●</span> Current</span>
        <span v-if="anyCalendar && !flexible" class="legend__item"><span aria-hidden="true">!</span> Missed</span>
        <span class="legend__item"><span aria-hidden="true">·</span> Upcoming</span>
      </div>

      <div class="week-grid">
        <template v-for="(w, i) in weeks" :key="w.n">
          <button
            type="button"
            class="week-tile"
            :class="[`week-tile--${status(w).key}`, { 'week-tile--race': w.kind === 'race-week', 'is-open': open === w.n }]"
            :aria-label="tileLabelText(w)"
            :aria-expanded="open === w.n"
            :aria-controls="open === w.n ? 'week-detail' : null"
            :data-current="w.current ? '' : null"
            @click="toggle(w.n)"
          >
            <span class="week-tile__head">
              <span class="week-tile__label">{{ tileLabel(w) }}</span>
              <span class="week-tile__status" aria-hidden="true">
                <svg v-if="w.kind === 'race-week'" class="icon icon--sm"><use href="#i-flag" /></svg>
                <template v-else>{{ status(w).glyph }}</template>
              </span>
            </span>
            <span class="week-tile__num">{{ w.n }}</span>
            <span class="week-tile__people" aria-hidden="true">
              <span v-for="p in PERSONS" :key="p" class="week-tile__person"><span class="dot dot--sm" :class="`dot--${p}`"></span>{{ tilePct(w[p]) }}</span>
            </span>
          </button>

          <div v-if="anchor === i && openWeek" id="week-detail" class="week-grid__detail week-detail card stack" role="region" :aria-label="`Week ${openWeek.n} details`">
            <div class="section-header">
              <h3 class="section-title">Week {{ openWeek.n }}<template v-if="openWeek.tag"> · {{ openWeek.tag }}</template></h3>
              <span class="text-sm text-muted">{{ shortDate(openWeek.startDate) }} – {{ shortDate(openWeek.endDate) }}</span>
            </div>

            <div class="week-detail__people">
              <div v-for="p in PERSONS" :key="p" class="stack stack--sm">
                <div class="row">
                  <div class="ring ring--sm" :class="`ring--${p}`" role="progressbar" :aria-valuenow="openWeek[p].pct ?? 0" aria-valuemin="0" aria-valuemax="100" :aria-label="`${store.names[p]}: ${openWeek[p].pct ?? 0}% done`" :style="{ '--value': openWeek[p].pct ?? 0 }">
                    <span class="ring__label">{{ openWeek[p].pct == null ? '–' : `${openWeek[p].pct}%` }}</span>
                  </div>
                  <div class="grow">
                    <div class="row row--sm text-semibold"><span class="dot" :class="`dot--${p}`"></span><span class="truncate">{{ store.names[p] }}</span></div>
                    <div class="text-sm text-muted">{{ formatKm(openWeek[p].doneKm) }} of {{ formatKm(openWeek[p].plannedKm) }} km run · {{ weekStatusText(openWeek[p], modes[p]) }}</div>
                  </div>
                </div>

                <div role="list" aria-label="Planned runs">
                  <div v-for="run in openWeek[p].runs" :key="run.id" class="week-detail__run" role="listitem">
                    <div class="week-detail__run-info">
                      <div class="week-detail__run-type">{{ run.type }} <span class="tag">×{{ run.mult }}</span>
                        <span v-if="run.repeat" class="tag">Repeat</span>
                        <span v-if="run.skipped" class="tag">Skipped</span>
                        <span v-else-if="run.matched" class="tag tag--accent">{{ run.matched.partial ? 'Partly done' : 'Done' }}</span>
                      </div>
                      <div v-if="run.detail" class="week-detail__run-note">{{ run.detail }}</div>
                      <div class="week-detail__run-note">
                        Plan {{ run.defaultKm == null ? '–' : formatKm(run.defaultKm) }} km
                        <button v-if="isOverridden(run)" type="button" class="btn btn--ghost btn--sm" @click="commitGoal(run, true)">Reset</button>
                      </div>
                      <p v-if="errors[run.id]" class="field__error" role="alert">{{ errors[run.id] }}</p>
                      <div v-if="canAct(p)" class="plan-actions">
                        <template v-if="run.skipped">
                          <button type="button" class="btn btn--ghost btn--sm" :class="{ 'is-loading': busyKey === `skip-${run.id}` }" :aria-label="`Undo skip, ${run.type}`" @click="unskipRun(run)">Undo skip</button>
                        </template>
                        <button v-else-if="!run.matched" type="button" class="btn btn--ghost btn--sm" :class="{ 'is-loading': busyKey === `skip-${run.id}` }" :aria-label="`Skip this session, ${run.type}`" @click="skipRun(run)">Skip this session</button>
                      </div>
                    </div>
                    <div class="input-group">
                      <input
                        class="input input--compact"
                        :class="`input--${p}`"
                        inputmode="decimal"
                        autocomplete="off"
                        :value="shownKm(run)"
                        :aria-label="`${store.names[p]} target km, ${run.type}`"
                        :aria-invalid="errors[run.id] ? 'true' : null"
                        @input="onGoalInput(run, $event)"
                        @blur="commitGoal(run)"
                        @keydown.enter="$event.target.blur()"
                      >
                      <span class="input-group__addon">km</span>
                    </div>
                  </div>
                  <p v-if="!openWeek[p].runs.length" class="text-sm text-muted">No runs planned.</p>
                </div>

                <div v-if="canAct(p) && openWeek[p].runs.length" class="plan-actions">
                  <template v-if="weekRepeated(openWeek)">
                    <span class="tag">Repeated</span>
                    <button type="button" class="btn btn--ghost btn--sm" :class="{ 'is-loading': busyKey === `repeat-${openWeek.n}` }" @click="undoRepeat(openWeek)">Undo repeat</button>
                  </template>
                  <button v-else type="button" class="btn btn--secondary btn--sm" :class="{ 'is-loading': busyKey === `repeat-${openWeek.n}` }" @click="repeatThisWeek(openWeek)">Repeat this week</button>
                </div>

                <div>
                  <h4 class="text-eyebrow">Logged this week</h4>
                  <div v-if="openWeek[p].entries.length" role="list">
                    <div v-for="e in openWeek[p].entries" :key="e.id" class="week-detail__entry" role="listitem">
                      <span aria-hidden="true">{{ SPORT_BY_KEY[e.sport] ? SPORT_BY_KEY[e.sport].emoji : '' }}</span>
                      <span class="week-detail__entry-title">{{ e.title || SPORT_BY_KEY[e.sport].label }} <span class="text-faint">· {{ entryWhen(e) }}</span></span>
                      <span class="week-detail__entry-meta">{{ entryMeta(e) }}</span>
                    </div>
                  </div>
                  <p v-else class="text-sm text-muted">Nothing logged yet.</p>
                </div>
              </div>
            </div>
          </div>
        </template>
      </div>
    </div>
  </section>
</template>
