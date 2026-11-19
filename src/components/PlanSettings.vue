<script setup>
// PlanSettings ("My plan"): the signed-in person's own plan state: plan mode, start date, race date, weekly target, training
// days, pauses, skipped sessions and repeated weeks. The other person's start / race date are shown read-only.
// Props: open (boolean), section ('mode'|'start'|'race'|'target'|'days'|'pauses'|'skipped'|'' : scrolled to on open).
// Emits: 'close'. Lazy-loaded by App.vue (defineAsyncComponent), opened from Settings and from the Plan tab.
// Everything autosaves on change (debounced) through the plan actions of store.js, which validate and write plans/<me> only.
import { ref, computed, watch, nextTick, onBeforeUnmount } from 'vue';
import {
  store, today, planStates, weekStreaks, effectiveStartForPerson, setPlanState, setPlanMode, setRaceDate, setTrainingDays, setWeeklyTarget,
  addPause, removePause, unskipSession, unrepeatWeek
} from '../store.js';
import { PLAN } from '../plan.js';
import { defaultWeeklyTarget } from '../planModel.js';
import { formatDateLong } from '../scoring.js';
import { shortDate } from '../viewmodels.js';
import { useSheet } from '../utils/useSheet.js';
import {
  WEEKDAY_CHIPS, toggleTrainingDay, trainingDaysText, stepTarget, raceCountdownText, raceDateError, raceAlignment,
  pauseError, quickPause, pauseRangeText, pauseState, activePause, sessionLabel
} from '../utils/planSettingsForm.js';
import { modeSwitchPreview } from '../utils/modeSwitch.js';

const props = defineProps({ open: { type: Boolean, default: false }, section: { type: String, default: '' } });
const emit = defineEmits(['close']);

const panel = ref(null);
const close = () => emit('close');
useSheet(() => props.open, panel, close);

const me = computed(() => store.me);
const mine = computed(() => (me.value ? planStates.value[me.value] : null));
const other = computed(() => (me.value === 'a' ? 'b' : 'a'));
const otherState = computed(() => planStates.value[other.value]);
const names = computed(() => store.names);

/* ---------- autosave: debounce per control, one status line ---------- */

const error = ref('');
const status = ref(''); // '' | 'saving' | 'saved'
let savedTimer = null;
const timers = {};
const queued = {};

async function run(key, fn) {
  delete timers[key];
  delete queued[key];
  error.value = '';
  status.value = 'saving';
  try {
    await fn();
    status.value = 'saved';
    clearTimeout(savedTimer);
    savedTimer = setTimeout(() => { if (status.value === 'saved') status.value = ''; }, 2500);
  } catch (e) {
    status.value = '';
    error.value = (e && e.message) || "Couldn't save. Check your connection and try again.";
    syncDrafts(); // show what is really stored
  }
}
function schedule(key, fn, delay = 500) {
  clearTimeout(timers[key]);
  queued[key] = fn;
  timers[key] = setTimeout(() => run(key, fn), delay);
}
function flushAll() {
  for (const key of Object.keys(timers)) { clearTimeout(timers[key]); run(key, queued[key]); }
}
watch(() => props.open, o => { if (!o) flushAll(); });
onBeforeUnmount(() => { flushAll(); clearTimeout(savedTimer); });

/* ---------- drafts (what is typed; the store holds the validated value) ---------- */

const startDraft = ref('');
const raceDraft = ref('');
const targetDraft = ref(null); // number or null (automatic)
const raceInputError = ref('');
function syncDrafts() {
  const s = mine.value;
  if (!s) return;
  if (!timers.start) startDraft.value = s.startDate || '';
  if (!timers.race) { raceDraft.value = s.raceDate || ''; raceInputError.value = ''; }
  if (!timers.target) targetDraft.value = s.weeklyTarget;
}
watch(mine, syncDrafts, { immediate: true, deep: true });

/* ---------- plan mode + preview ---------- */

const MODE_TEXT = {
  calendar: 'Fixed weeks: every plan week has its own dates from your start date. A week you do not finish counts as missed.',
  rolling: 'Flexible: the plan follows your progress. Your next session is the first one you have not done yet, and weeks never count as missed. If you fall behind you only see how many sessions you are behind.'
};
const mode = computed(() => (mine.value ? mine.value.mode : 'calendar'));
const pendingMode = ref(null); // the other mode while its preview is shown
const preview = computed(() => (pendingMode.value && me.value
  ? modeSwitchPreview({ person: me.value, to: pendingMode.value, log: store.log, goals: store.goals, planState: planStates.value, todayISO: today.value })
  : null));
const switching = ref(false);
function pickMode(m) {
  error.value = '';
  pendingMode.value = m === mode.value ? null : m;
}
async function confirmMode() {
  if (!pendingMode.value || switching.value) return;
  switching.value = true;
  await run('mode', () => setPlanMode(pendingMode.value));
  if (!error.value) pendingMode.value = null;
  switching.value = false;
}

/* ---------- start date ---------- */

const effectiveStart = computed(() => (me.value ? effectiveStartForPerson(me.value) : today.value));
const startSource = computed(() => {
  if (mine.value && mine.value.startDate) return 'own';
  return store.settings.startDate ? 'shared' : 'auto';
});
const startHint = computed(() => ({
  own: 'Your own start date.',
  shared: 'The shared start date from before is used. Set your own to override it.',
  auto: "Automatic: the Monday of the week of your first logged run."
}[startSource.value]));
function onStart(ev) {
  startDraft.value = ev.target.value;
  const v = startDraft.value || null;
  schedule('start', () => setPlanState(me.value, { startDate: v }));
}
function useAutoStart() {
  startDraft.value = '';
  schedule('start', () => setPlanState(me.value, { startDate: null }), 0);
}

/* ---------- race date ---------- */

const raceError = computed(() => raceInputError.value || (mine.value ? raceDateError(mine.value.raceDate, effectiveStart.value) : ''));
const countdown = computed(() => (mine.value && mine.value.raceDate ? raceCountdownText(today.value, mine.value.raceDate) : ''));
const alignment = computed(() => (mine.value && mine.value.raceDate ? raceAlignment(effectiveStart.value, mine.value.raceDate, PLAN.length) : null));
function onRace(ev) {
  raceDraft.value = ev.target.value;
  const v = raceDraft.value || null;
  raceInputError.value = raceDateError(v, effectiveStart.value);
  if (raceInputError.value) { clearTimeout(timers.race); delete timers.race; delete queued.race; return; }
  schedule('race', () => setRaceDate(v));
}
function clearRace() {
  raceDraft.value = '';
  raceInputError.value = '';
  schedule('race', () => setRaceDate(null), 0);
}
function useIdealStart() {
  if (!alignment.value || !alignment.value.idealStart) return;
  startDraft.value = alignment.value.idealStart;
  schedule('start', () => setPlanState(me.value, { startDate: alignment.value.idealStart }), 0);
}

/* ---------- weekly target ---------- */

const autoTarget = computed(() => defaultWeeklyTarget(PLAN, me.value || undefined));
const targetAuto = computed(() => targetDraft.value == null);
const shownTarget = computed(() => (targetDraft.value == null ? autoTarget.value : targetDraft.value));
const streak = computed(() => (me.value ? weekStreaks.value[me.value] : null));
function step(delta) {
  targetDraft.value = stepTarget(targetDraft.value, delta, autoTarget.value);
  const v = targetDraft.value;
  schedule('target', () => setWeeklyTarget(v));
}
function onTargetAuto(ev) {
  targetDraft.value = ev.target.checked ? null : autoTarget.value;
  const v = targetDraft.value;
  schedule('target', () => setWeeklyTarget(v), 0);
}

/* ---------- training days ---------- */

const days = ref([]);
watch(() => mine.value && mine.value.trainingDays, d => { if (!timers.days) days.value = [...(d || [])]; }, { immediate: true });
function toggleDay(d) {
  days.value = toggleTrainingDay(days.value, d);
  const v = days.value;
  schedule('days', () => setTrainingDays(v), 400);
}

/* ---------- pauses ---------- */

const pauses = computed(() => (mine.value ? mine.value.pauses : []));
const current = computed(() => activePause(pauses.value, today.value));
const untilDraft = ref('');
const quickError = ref('');
const addOpen = ref(false);
const newPause = ref({ from: '', to: '', note: '' });
const pauseFormError = ref('');

async function pauseNow() {
  quickError.value = '';
  const q = quickPause(today.value, untilDraft.value);
  if (!q.ok) { quickError.value = q.error; return; }
  await run('pause', () => addPause(q.pause));
  if (!error.value) untilDraft.value = '';
}
async function submitPause() {
  pauseFormError.value = pauseError(newPause.value);
  if (pauseFormError.value) return;
  const { from, to, note } = newPause.value;
  const pause = note.trim() ? { from, to, note: note.trim() } : { from, to };
  await run('pause', () => addPause(pause));
  if (!error.value) { newPause.value = { from: '', to: '', note: '' }; addOpen.value = false; }
}
const dropPause = i => run('pause', () => removePause(i));
// End a running pause: today is the first day back. (A pause that starts today or later disappears.)
function resumeToday() {
  const p = current.value;
  if (!p) return;
  const yesterday = new Date(`${today.value}T00:00:00Z`);
  yesterday.setUTCDate(yesterday.getUTCDate() - 1);
  const y = yesterday.toISOString().slice(0, 10);
  const list = pauses.value.flatMap(x => (x !== p ? [x] : p.from <= y ? [{ ...p, to: y }] : []));
  run('pause', () => setPlanState(me.value, { pauses: list }));
}

/* ---------- skipped sessions and repeated weeks ---------- */

const skipped = computed(() => (mine.value ? mine.value.skipped : []));
const repeated = computed(() => (mine.value ? mine.value.repeatWeeks || [] : []));
const undoSkip = id => run('skip', () => unskipSession(id));
const undoRepeat = n => run('repeat', () => unrepeatWeek(n));
const repeatLabel = n => `Week ${n}`;
const repeatKey = n => n;
const toPlanTab = () => { location.hash = '#/plan'; close(); };

/* ---------- other person (read-only) ---------- */

const otherLine = computed(() => {
  const s = otherState.value;
  const parts = [`starts ${shortDate(effectiveStartForPerson(other.value))}`];
  parts.push(s.raceDate ? `race ${shortDate(s.raceDate)}` : 'no race date');
  if (s.mode === 'rolling') parts.push('flexible plan');
  return parts.join(' · ');
});

/* ---------- open: scroll to the requested section ---------- */

watch(() => [props.open, props.section], async ([o, s]) => {
  if (!o || !s) return;
  await nextTick();
  const el = panel.value && panel.value.querySelector(`#plan-sec-${s}`);
  if (el) el.scrollIntoView({ block: 'start' });
}, { immediate: true });
</script>

<template>
  <Transition name="sheet">
    <div v-if="open" class="sheet">
      <div class="sheet__backdrop" @click="close"></div>
      <div ref="panel" class="sheet__panel" role="dialog" aria-modal="true" aria-labelledby="plan-settings-title">
        <div class="sheet__handle"></div>
        <header class="sheet__header">
          <h2 id="plan-settings-title" class="sheet__title">My plan</h2>
          <span class="text-sm plan-settings__status" :class="status === 'saved' ? 'text-success' : 'text-muted'" role="status">{{ status === 'saved' ? 'Saved' : status === 'saving' ? 'Saving…' : '' }}</span>
          <button type="button" class="btn btn--ghost btn--icon btn--round" aria-label="Close" @click="close"><svg class="icon" aria-hidden="true"><use href="#i-x" /></svg></button>
        </header>

        <div v-if="mine" class="sheet__body stack stack--lg">
          <div v-if="error" class="banner banner--danger" role="alert">
            <span class="banner__icon"><svg class="icon" aria-hidden="true"><use href="#i-alert" /></svg></span>
            <div class="banner__body"><div class="banner__text">{{ error }}</div></div>
          </div>

          <p class="text-sm text-muted">These settings are only about your own plan. {{ names[other] }} has their own. Changes save by themselves.</p>

          <!-- Plan mode -->
          <section id="plan-sec-mode" class="stack stack--sm" aria-labelledby="ps-mode">
            <h3 id="ps-mode" class="text-eyebrow">Plan mode</h3>
            <div class="segmented" role="group" aria-label="Plan mode">
              <button type="button" class="segmented__item" :aria-pressed="(pendingMode || mode) === 'calendar'" @click="pickMode('calendar')">Fixed weeks</button>
              <button type="button" class="segmented__item" :aria-pressed="(pendingMode || mode) === 'rolling'" @click="pickMode('rolling')">Flexible</button>
            </div>
            <p class="text-sm text-muted">{{ MODE_TEXT[pendingMode || mode] }}</p>

            <div v-if="pendingMode" class="card card--inset card--flat stack stack--sm" role="region" aria-label="What changes">
              <h4 class="text-semibold">What changes</h4>
              <ul v-if="preview && preview.lines.length" class="plan-settings__changes">
                <li v-for="l in preview.lines" :key="l">{{ l }}</li>
              </ul>
              <p v-else class="text-sm text-muted">
                {{ pendingMode === 'rolling'
                  ? 'Your logged runs are kept. From now on your next session is the first one you have not done yet, and no week counts as missed.'
                  : 'Your logged runs are kept. From now on every plan week follows the calendar again, and an unfinished week counts as missed.' }}
              </p>
              <p class="text-xs text-faint">You can switch back at any time. Nothing you logged changes.</p>
              <div class="grid grid--stack-mobile">
                <button type="button" class="btn btn--primary" :class="{ 'is-loading': switching }" :disabled="switching" @click="confirmMode">
                  {{ pendingMode === 'rolling' ? 'Switch to flexible plan' : 'Switch to fixed weeks' }}
                </button>
                <button type="button" class="btn btn--secondary" :disabled="switching" @click="pendingMode = null">
                  {{ pendingMode === 'rolling' ? 'Stay on fixed weeks' : 'Stay flexible' }}
                </button>
              </div>
            </div>
          </section>

          <!-- Start date -->
          <section id="plan-sec-start" class="stack stack--sm" aria-labelledby="ps-start">
            <h3 id="ps-start" class="text-eyebrow">Start date</h3>
            <div class="field">
              <label class="field__label" for="ps-start-date">Week 1 starts on</label>
              <input id="ps-start-date" class="input" type="date" :value="startDraft" @input="onStart" @change="onStart">
              <p class="field__hint text-sm text-muted">
                Currently <strong class="text-strong">{{ formatDateLong(effectiveStart) }}</strong>. {{ startHint }}
              </p>
            </div>
            <div v-if="mine.startDate"><button type="button" class="btn btn--secondary btn--sm" @click="useAutoStart">Use automatic start</button></div>
          </section>

          <!-- Race date -->
          <section id="plan-sec-race" class="stack stack--sm" aria-labelledby="ps-race">
            <h3 id="ps-race" class="text-eyebrow">Race date (optional)</h3>
            <div class="field" :class="{ 'field--error': raceError }">
              <label class="field__label" for="ps-race-date">Race day</label>
              <input id="ps-race-date" class="input" type="date" :value="raceDraft" :min="effectiveStart" :aria-invalid="raceError ? 'true' : null" :aria-describedby="raceError ? 'ps-race-error' : 'ps-race-hint'" @input="onRace" @change="onRace">
              <p v-if="raceError" id="ps-race-error" class="field__error" role="alert">{{ raceError }}</p>
              <p v-else id="ps-race-hint" class="field__hint text-sm text-muted">
                <template v-if="countdown"><strong class="text-strong">{{ countdown }}</strong>. </template>
                <template v-if="alignment">{{ alignment.hint }}</template>
                <template v-else-if="!mine.raceDate">Shows the weeks left and whether your plan fits before race day.</template>
              </p>
            </div>
            <div class="row row--wrap">
              <button v-if="alignment && alignment.diff !== 0 && alignment.idealStart && alignment.idealStart !== mine.startDate" type="button" class="btn btn--secondary btn--sm" @click="useIdealStart">
                Start on {{ shortDate(alignment.idealStart) }} to end on race day
              </button>
              <button v-if="mine.raceDate" type="button" class="btn btn--ghost btn--sm" @click="clearRace">Remove race date</button>
            </div>
          </section>

          <!-- Weekly target -->
          <section id="plan-sec-target" class="stack stack--sm" aria-labelledby="ps-target">
            <h3 id="ps-target" class="text-eyebrow">Weekly target</h3>
            <div class="stepper" role="group" aria-label="Runs per week">
              <button type="button" class="btn btn--secondary btn--icon btn--round" aria-label="Fewer runs per week" :disabled="targetAuto" @click="step(-1)">−</button>
              <div class="stepper__value" aria-live="polite"><span class="stepper__num num">{{ shownTarget }}</span><span class="stepper__unit">{{ shownTarget === 1 ? 'run' : 'runs' }} per week</span></div>
              <button type="button" class="btn btn--secondary btn--icon btn--round" aria-label="More runs per week" :disabled="targetAuto" @click="step(1)">+</button>
            </div>
            <label class="switch">
              <input class="switch__input" type="checkbox" :checked="targetAuto" @change="onTargetAuto">
              <span class="switch__track"></span>
              <span class="switch__label">Automatic ({{ autoTarget }} per week)</span>
            </label>
            <p class="text-sm text-muted">
              Drives your week streak: a week, Monday to Sunday, counts when you log at least this many runs.
              <template v-if="streak">Right now: {{ streak.current }} {{ streak.current === 1 ? 'week' : 'weeks' }} in a row, {{ streak.thisWeek.runs }} of {{ streak.thisWeek.target }} runs this week.</template>
            </p>
          </section>

          <!-- Training days -->
          <section id="plan-sec-days" class="stack stack--sm" aria-labelledby="ps-days">
            <h3 id="ps-days" class="text-eyebrow">Training days</h3>
            <div class="weekday-grid" role="group" aria-label="Training days">
              <button v-for="c in WEEKDAY_CHIPS" :key="c.day" type="button" class="chip weekday-grid__chip" :aria-pressed="days.includes(c.day)" :aria-label="c.long" @click="toggleDay(c.day)">{{ c.short }}</button>
            </div>
            <p class="text-sm text-muted">
              <template v-if="mode !== 'rolling'">Used by the flexible plan only: fixed weeks ignore it, reminders and suggestions stay as they are.{{ days.length ? ` Saved: ${trainingDaysText(days)}.` : '' }}</template>
              <template v-else-if="days.length">Reminders and suggestions favour {{ trainingDaysText(days) }}.</template>
              <template v-else>Automatic: long runs at the weekend, quality runs Tuesday to Thursday. Pick the days you usually run to change that.</template>
            </p>
          </section>

          <!-- Pauses -->
          <section id="plan-sec-pauses" class="stack stack--sm" aria-labelledby="ps-pauses">
            <h3 id="ps-pauses" class="text-eyebrow">Pauses</h3>
            <p class="text-sm text-muted">
              Holiday or illness? Paused days do not break your week streak<template v-if="mode === 'rolling'"> and do not count as behind. No reminders while paused</template><template v-else>. Fixed weeks keep following the calendar; switch to the flexible plan to move the weeks</template>.
            </p>

            <div v-if="current" class="banner" role="status">
              <span class="banner__icon"><svg class="icon" aria-hidden="true"><use href="#i-info" /></svg></span>
              <div class="banner__body">
                <div class="banner__title">Your plan is paused until {{ shortDate(current.to) }}</div>
                <div class="banner__action plan-settings__banner-action"><button type="button" class="btn btn--secondary btn--sm" @click="resumeToday">Resume today</button></div>
              </div>
            </div>

            <div class="field" :class="{ 'field--error': quickError }">
              <label class="field__label" for="ps-pause-until">Pause my plan from today until</label>
              <div class="plan-settings__inline">
                <input id="ps-pause-until" v-model="untilDraft" class="input" type="date" :min="today" :data-autofocus="section === 'pauses' ? '' : null" :aria-invalid="quickError ? 'true' : null">
                <button type="button" class="btn btn--primary" @click="pauseNow">Pause</button>
              </div>
              <p v-if="quickError" class="field__error" role="alert">{{ quickError }}</p>
            </div>

            <div v-if="pauses.length" class="list list--card" role="list" aria-label="Your pauses">
              <div v-for="(p, i) in pauses" :key="`${p.from}-${p.to}`" class="list-item" role="listitem">
                <div class="list-item__body">
                  <span class="list-item__title">{{ pauseRangeText(p, today) }}</span>
                  <span v-if="p.note || pauseState(p, today) !== 'past'" class="list-item__subtitle">
                    {{ [pauseState(p, today) === 'active' ? 'Now' : pauseState(p, today) === 'upcoming' ? 'Upcoming' : '', p.note].filter(Boolean).join(' · ') }}
                  </span>
                </div>
                <button type="button" class="btn btn--ghost btn--icon btn--round" :aria-label="`Remove pause ${pauseRangeText(p, today)}`" @click="dropPause(i)">
                  <svg class="icon" aria-hidden="true"><use href="#i-trash" /></svg>
                </button>
              </div>
            </div>

            <details class="disclosure" :open="addOpen" @toggle="addOpen = $event.target.open">
              <summary class="disclosure__summary">Add a pause for other dates</summary>
              <div class="disclosure__body stack stack--sm">
                <div class="grid grid--stack-mobile">
                  <div class="field">
                    <label class="field__label" for="ps-pause-from">From</label>
                    <input id="ps-pause-from" v-model="newPause.from" class="input" type="date">
                  </div>
                  <div class="field">
                    <label class="field__label" for="ps-pause-to">To (including)</label>
                    <input id="ps-pause-to" v-model="newPause.to" class="input" type="date" :min="newPause.from || null">
                  </div>
                </div>
                <div class="field">
                  <label class="field__label" for="ps-pause-note">Note (optional)</label>
                  <input id="ps-pause-note" v-model="newPause.note" class="input" type="text" maxlength="80" placeholder="Holiday, flu…" autocomplete="off">
                </div>
                <p v-if="pauseFormError" class="field__error" role="alert">{{ pauseFormError }}</p>
                <div><button type="button" class="btn btn--primary" @click="submitPause">Add pause</button></div>
              </div>
            </details>
          </section>

          <!-- Skipped sessions and repeated weeks -->
          <section id="plan-sec-skipped" class="stack stack--sm" aria-labelledby="ps-skipped">
            <h3 id="ps-skipped" class="text-eyebrow">Skipped sessions and repeated weeks</h3>
            <div v-if="skipped.length || repeated.length" class="list list--card" role="list" aria-label="Skipped sessions and repeated weeks">
              <div v-for="id in skipped" :key="`s-${id}`" class="list-item" role="listitem">
                <div class="list-item__body"><span class="list-item__title">{{ sessionLabel(id) }}</span><span class="list-item__subtitle">Skipped</span></div>
                <button type="button" class="btn btn--secondary btn--sm" :aria-label="`Undo skip, ${sessionLabel(id)}`" @click="undoSkip(id)">Undo</button>
              </div>
              <div v-for="r in repeated" :key="`r-${repeatKey(r)}`" class="list-item" role="listitem">
                <div class="list-item__body"><span class="list-item__title">{{ repeatLabel(r) }}</span><span class="list-item__subtitle">Repeated</span></div>
                <button type="button" class="btn btn--secondary btn--sm" :aria-label="`Undo repeat, ${repeatLabel(r)}`" @click="undoRepeat(repeatKey(r))">Undo</button>
              </div>
            </div>
            <p v-else class="text-sm text-muted">Nothing skipped or repeated yet.</p>
            <p class="text-sm text-muted">Skip a session you cannot do, or repeat a week you want to do again, from the Plan tab: open a week and use the buttons under your runs.</p>
            <div><button type="button" class="btn btn--secondary btn--sm" @click="toPlanTab">Open the Plan tab</button></div>
          </section>

          <div class="card card--inset card--flat row" :class="`card--${other}`">
            <span class="dot" :class="`dot--${other}`"></span>
            <p class="text-sm grow"><strong class="text-strong">{{ names[other] }}</strong> {{ otherLine }}. <span class="text-muted">Only they can change this.</span></p>
          </div>
        </div>
      </div>
    </div>
  </Transition>
</template>
