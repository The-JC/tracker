<script setup>
// StatsView: per-person totals, longest run, best pace, streak, last-8-weeks km grouped bars (inline SVG), run types explained.
// Props: none. Emits: none. Lazy-loaded by App.vue.
// Reads stats (computed -> {a,b}), store.names; RUN_TYPES from plan.js; formatPace/formatKm from scoring.js.
import { computed } from 'vue';
import { store, stats } from '../store.js';
import { formatPace, formatKm, formatPoints } from '../scoring.js';
import { RUN_TYPES } from '../plan.js';
import { PERSONS, chartModel, shortDate } from '../viewmodels.js';

const chart = computed(() => chartModel(stats.value.a.weeklyKm, stats.value.b.weeklyKm));
const chartLabel = computed(() => {
  const c = chart.value;
  const first = c.groups[0], last = c.groups[c.groups.length - 1];
  return `Kilometres per week, ${shortDate(first.weekStart)} to the week of ${shortDate(last.weekStart)}, ${store.names.a} and ${store.names.b}`;
});
const rows = computed(() => PERSONS.map(p => {
  const s = stats.value[p];
  return {
    p,
    top: [
      { label: 'Distance', value: formatKm(s.totalKm), unit: 'km' },
      { label: 'Points', value: formatPoints(s.totalPoints) },
      { label: 'Activities', value: String(s.count) }
    ],
    bottom: [
      { label: 'Longest run', value: s.longestRunKm > 0 ? formatKm(s.longestRunKm) : '–', unit: s.longestRunKm > 0 ? 'km' : '' },
      { label: 'Best pace', value: formatPace(s.bestPaceMinPerKm), unit: s.bestPaceMinPerKm ? '/km' : '' },
      { label: 'Streak', value: String(s.streakDays), unit: s.streakDays === 1 ? 'day' : 'days' }
    ]
  };
}));
</script>

<template>
  <section class="stack stack--lg" aria-label="Statistics">
    <div class="grid grid--stack-mobile">
      <article v-for="r in rows" :key="r.p" class="card stack" :class="`card--${r.p}`" :aria-label="`${store.names[r.p]} totals`">
        <div class="row row--sm"><span class="dot" :class="`dot--${r.p}`"></span><h2 class="section-title truncate">{{ store.names[r.p] }}</h2></div>
        <div class="stat-row" :class="`stat-row--divided`">
          <div v-for="s in r.top" :key="s.label" class="stat stat--sm" :class="`stat--${r.p}`">
            <span class="stat__value">{{ s.value }}<span v-if="s.unit" class="stat__unit">{{ s.unit }}</span></span>
            <span class="stat__label">{{ s.label }}</span>
          </div>
        </div>
        <div class="stat-row stat-row--divided">
          <div v-for="s in r.bottom" :key="s.label" class="stat stat--sm">
            <span class="stat__value">{{ s.value }}<span v-if="s.unit" class="stat__unit">{{ s.unit }}</span></span>
            <span class="stat__label">{{ s.label }}</span>
          </div>
        </div>
      </article>
    </div>

    <section class="card stack" aria-labelledby="chart-title">
      <div class="section-header">
        <h2 id="chart-title" class="section-title">Kilometres per week</h2>
        <span class="text-sm text-muted">Last 8 weeks, runs + hikes</span>
      </div>
      <svg class="bar-chart" :viewBox="`0 0 ${chart.width} ${chart.height}`" role="img" :aria-label="chartLabel">
        <title>{{ chartLabel }}</title>
        <template v-for="t in chart.ticks" :key="t.value">
          <line :class="t.value === 0 ? 'bar-chart__axis' : 'bar-chart__grid'" x1="30" :x2="chart.width" :y1="t.y" :y2="t.y" />
          <text class="bar-chart__value" x="24" :y="t.y + 3" text-anchor="end">{{ t.value }}</text>
        </template>
        <g v-for="g in chart.groups" :key="g.weekStart">
          <rect v-for="p in PERSONS" :key="p" class="bar" :class="[`bar--${p}`, { 'bar--empty': g[p].km === 0 }]" :x="g[p].x" :y="g[p].km === 0 ? chart.base - 2 : g[p].y" :width="g[p].w" :height="g[p].km === 0 ? 2 : g[p].h" rx="3">
            <title>{{ store.names[p] }}, week of {{ shortDate(g.weekStart) }}: {{ formatKm(g[p].km) }} km</title>
          </rect>
          <text class="bar-chart__label" :class="{ 'bar-chart__label--current': g.current }" :x="g.cx" :y="chart.base + 14">{{ g.label }}</text>
        </g>
      </svg>
      <div class="legend">
        <span v-for="p in PERSONS" :key="p" class="legend__item"><span class="dot" :class="`dot--${p}`"></span>{{ store.names[p] }}</span>
        <span v-if="!chart.hasData" class="text-muted">No distance logged in the last 8 weeks.</span>
      </div>
      <table class="sr-only">
        <caption>Kilometres per week (runs and hikes)</caption>
        <thead><tr><th scope="col">Week of</th><th v-for="p in PERSONS" :key="p" scope="col">{{ store.names[p] }}</th></tr></thead>
        <tbody>
          <tr v-for="g in chart.groups" :key="g.weekStart"><th scope="row">{{ shortDate(g.weekStart) }}</th><td v-for="p in PERSONS" :key="p">{{ formatKm(g[p].km) }} km</td></tr>
        </tbody>
      </table>
    </section>

    <details class="disclosure">
      <summary class="disclosure__summary">Run types explained</summary>
      <div class="disclosure__body stack">
        <p class="text-sm text-muted">Points for a run are the kilometres times the run type's multiplier. Harder runs are worth more.</p>
        <div class="runtype-grid">
          <div v-for="t in RUN_TYPES" :key="t.key" class="card card--inset card--flat stack stack--sm">
            <div class="row row--between">
              <h3 class="text-semibold">{{ t.name }}</h3>
              <span class="tag tag--accent">×{{ t.mult }} pts/km</span>
            </div>
            <p class="text-sm text-strong text-medium">{{ t.why }}</p>
            <p class="text-sm text-muted">{{ t.how }}</p>
          </div>
        </div>
      </div>
    </details>
  </section>
</template>
