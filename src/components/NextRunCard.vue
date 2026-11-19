<script setup>
// NextRunCard: "Next up" recommendation for the signed-in person, on top of the Feed.
// Props: none. Emits: 'log' (open the Log sheet; it is prefilled through logPrefill.js when a run is recommended).
// Reads store.me / log / weeks (store.js). All decisions come from recommendForPerson.js / recommend.js (pure, rule based, explainable).
import { computed } from 'vue';
import { store, weeks, today } from '../store.js';
import { recommendForPerson } from '../recommendForPerson.js';
import { formatKm } from '../scoring.js';
import { setLogPrefill } from '../logPrefill.js';
import '../../css/next-run.css';

const emit = defineEmits(['log']);

const WEEKDAYS = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday'];
const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
const utc = iso => { const [y, m, d] = iso.split('-').map(Number); return new Date(Date.UTC(y, m - 1, d)); };
const dayLabel = iso => {
  const diff = Math.round((utc(iso) - utc(today.value)) / 86400000);
  if (diff === 0) return 'Today';
  if (diff === 1) return 'Tomorrow';
  return `${WEEKDAYS[utc(iso).getUTCDay()]} ${utc(iso).getUTCDate()} ${MONTHS[utc(iso).getUTCMonth()]}`;
};

const rec = computed(() => {
  if (!store.me || !store.logLoaded) return null;
  // Same pipeline the daily reminder (Worker) uses, so the card and the push can never disagree.
  return recommendForPerson({
    person: store.me, log: store.log, goals: store.goals, startDateSetting: store.settings.startDate, planState: store.plans, todayISO: today.value
  }).rec;
});

// Flexible plan with a race date: do the open sessions fit before race day? ({ daysLeft, sessionsLeft, slots, fits, shortBy })
const feasibility = computed(() => (rec.value && rec.value.raceFeasibility) || null);
const plural = (n, one) => `${n} ${n === 1 ? one : `${one}s`}`;
const feasibilityText = computed(() => {
  const f = feasibility.value;
  if (!f) return '';
  return f.fits
    ? `${plural(f.daysLeft, 'day')} to race day: ${plural(f.sessionsLeft, 'session')} left and room for ${plural(f.slots, 'run')}. That fits.`
    : `${plural(f.daysLeft, 'day')} to race day: ${plural(f.sessionsLeft, 'session')} left but only room for ${plural(f.slots, 'run')}. ${f.shortBy === 1 ? 'One session' : `${f.shortBy} sessions`} too many: skip an optional one, add training days or move the race date.`;
});

const runText = run => (run.km ? `${run.type} · ${formatKm(run.km)} km` : run.type);

// Icon (from the sprite in index.html), headline and sub line per state.
const view = computed(() => {
  const r = rec.value;
  if (!r) return null;
  const run = r.run;
  const planDone = r.tags.includes('Plan complete');
  switch (r.kind) {
    case 'run':
      return {
        icon: run.runType === 'race' ? 'i-flag' : 'i-feed',
        title: run.type, km: run.km ? formatKm(run.km) : null, sub: run.detail === `${run.km} km` ? '' : run.detail
      };
    case 'rest':
      return {
        icon: 'i-info', title: 'Rest day', km: null,
        sub: run ? `${dayLabel(r.forDate)}: ${runText(run)}${run.detail ? ` (${run.detail})` : ''}` : ''
      };
    case 'ahead':
      return { icon: 'i-check', title: 'Ahead of plan', km: null, sub: `Week ${r.weekNumber} is complete` };
    case 'not-started':
      return { icon: 'i-plan', title: 'Plan not started', km: null, sub: `Week 1 begins ${dayLabel(r.startsOn)}` };
    default:
      return planDone
        ? { icon: 'i-flag', title: 'Plan complete', km: null, sub: '' }
        : { icon: 'i-check', title: `Week ${r.weekNumber} done`, km: null, sub: '' };
  }
});

const summary = computed(() => (rec.value && rec.value.summary) || null);
const showProgress = computed(() => summary.value && summary.value.weekNumber && summary.value.totalCount > 0);
const pct = computed(() => (summary.value && summary.value.totalCount ? Math.round((100 * summary.value.doneCount) / summary.value.totalCount) : 0));
const nextId = computed(() => (rec.value && rec.value.kind === 'run' && rec.value.run ? rec.value.run.id : null));
const stepName = run => ({ long: 'Long', race: 'Race' }[run.runType] || run.type);
const stepState = it => (it.done ? 'done' : it.id === nextId.value ? 'next up' : it.partial ? 'started' : 'open');

const ctaLabel = computed(() => {
  const r = rec.value;
  if (!r) return '';
  if (r.kind === 'run') return r.run.km ? 'Log this run' : 'Log a jog';
  return r.kind === 'rest' ? 'Log a run anyway' : 'Log an activity';
});

function logIt() {
  const r = rec.value;
  if (r && r.kind === 'run') setLogPrefill({ sport: 'run', runType: r.run.runType, km: r.run.km });
  else setLogPrefill({ sport: 'run' });
  emit('log');
}

const RULES = [
  'Your logged runs of the current plan week are matched to the planned ones (same type first, then by distance). A planned run counts as done at 90% of its km.',
  'No hard run (tempo, speed, race) the day after a hard or a long run: an easy run is suggested for recovery instead.',
  'Long runs are suggested on Saturday or Sunday; Monday to Thursday they wait unless you are running out of days.',
  'Quality runs (tempo, speed) are preferred on Tuesday to Thursday, after at least one easy or rest day.',
  'More runs left than days in the week? Catch-up mode picks the most valuable run that is safe today.',
  'Already ran today, or three run days in a row? A rest day is suggested, with the next run lined up.',
  'More than 5 days without a run? You are eased back in with the easy run first.',
  'Race week: easy runs only, a short shakeout or rest the day before, and the race on the last day.'
];
</script>

<template>
  <section class="card card--hero next-run stack" aria-label="Next up" :aria-busy="rec ? null : 'true'">
    <template v-if="!rec">
      <div class="skeleton skeleton--text next-run__sk-eyebrow" aria-hidden="true"></div>
      <div class="skeleton skeleton--title" aria-hidden="true"></div>
      <div class="skeleton skeleton--text" aria-hidden="true"></div>
      <div class="skeleton skeleton--block" aria-hidden="true"></div>
    </template>

    <template v-else>
      <div class="row row--between">
        <span class="text-eyebrow">Next up</span>
        <span v-if="rec.weekNumber" class="chip chip--info">Week {{ rec.weekNumber }} of {{ weeks.length }}</span>
      </div>

      <div class="next-run__headline" :class="`next-run__headline--${rec.kind}`">
        <span class="next-run__icon" aria-hidden="true"><svg class="icon icon--lg"><use :href="`#${view.icon}`" /></svg></span>
        <div class="next-run__title-block">
          <h2 class="next-run__title">
            <span class="next-run__type">{{ view.title }}</span>
            <span v-if="view.km" class="next-run__km num">{{ view.km }}<span class="next-run__unit"> km</span></span>
          </h2>
          <p v-if="view.sub" class="next-run__sub">{{ view.sub }}</p>
        </div>
      </div>

      <p class="next-run__reason">{{ rec.reason }}</p>

      <div v-if="rec.tags.length" class="row row--sm row--wrap" aria-label="Why this run">
        <span v-for="t in rec.tags" :key="t" class="tag tag--accent">{{ t }}</span>
      </div>

      <div v-if="showProgress" class="stack stack--sm next-run__week">
        <div class="row row--between">
          <span class="text-sm text-strong">{{ summary.doneCount }} of {{ summary.totalCount }} planned this week</span>
          <span class="text-xs text-muted">{{ rec.daysLeftInWeek }} {{ rec.daysLeftInWeek === 1 ? 'day' : 'days' }} left</span>
        </div>
        <div class="progress progress--sm" :class="`progress--${store.me}`" role="progressbar" :aria-valuenow="pct" aria-valuemin="0" aria-valuemax="100"
          :aria-label="`${summary.doneCount} of ${summary.totalCount} planned runs done this week`" :style="{ '--value': pct }">
          <div class="progress__bar"></div>
        </div>
        <ul class="next-run__steps">
          <li v-for="it in summary.items.filter(i => !i.optional)" :key="it.run.id" class="next-run__step"
            :class="{ 'is-done': it.done, 'is-next': it.run.id === nextId }" :aria-label="`${runText(it.run)}: ${stepState(it)}`">
            <span class="next-run__step-mark" aria-hidden="true">
              <svg v-if="it.done" class="icon icon--sm"><use href="#i-check" /></svg>
            </span>
            <span class="next-run__step-text">
              <span class="next-run__step-type">{{ stepName(it.run) }}</span>
              <span class="next-run__step-km num">{{ formatKm(it.run.km) }} km</span>
            </span>
          </li>
        </ul>
      </div>

      <div v-if="feasibility" class="banner" :class="{ 'banner--warning': !feasibility.fits }" :role="feasibility.fits ? 'status' : 'alert'" data-testid="race-feasibility">
        <span class="banner__icon"><svg class="icon" aria-hidden="true"><use :href="feasibility.fits ? '#i-flag' : '#i-alert'" /></svg></span>
        <div class="banner__body">
          <div class="banner__title">{{ feasibility.fits ? 'On track for race day' : 'Race day is tight' }}</div>
          <div class="banner__text">{{ feasibilityText }}</div>
        </div>
      </div>

      <ul v-if="rec.alternatives.length" class="next-run__alts" aria-label="Other options">
        <li v-for="a in rec.alternatives" :key="a.run.id" class="next-run__alt">
          <span class="chip chip--info next-run__alt-chip">{{ runText(a.run) }}</span>
          <span class="text-xs text-muted next-run__alt-why">{{ a.why }}</span>
        </li>
      </ul>

      <button type="button" class="btn btn--block" :class="rec.kind === 'run' ? 'btn--primary btn--lg' : 'btn--secondary'" @click="logIt">{{ ctaLabel }}</button>

      <details class="disclosure">
        <summary class="disclosure__summary">How recommendations work</summary>
        <div class="disclosure__body">
          <ul class="next-run__rules">
            <li v-for="r in RULES" :key="r">{{ r }}</li>
          </ul>
        </div>
      </details>
    </template>
  </section>
</template>
