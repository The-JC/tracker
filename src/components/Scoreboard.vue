<script setup>
// Scoreboard: both people side by side (points, km, plan %, day streak, week streak) + this-week head-to-head.
// Props: none. Emits: none. Reads scoreboard, stats, weeks (store.js) and store.names. Person colours always come with the name.
import { computed } from 'vue';
import { store, scoreboard, stats, weeks, weekWindows, weekStreaks } from '../store.js';
import { formatKm, formatPoints } from '../scoring.js';
import { thisWeekSummary, weekStreakText, thisWeekRunsText, PERSONS } from '../viewmodels.js';

const summary = computed(() => thisWeekSummary(weeks.value, stats.value, weekWindows.value));
const streakText = n => (n === 0 ? 'No streak yet' : n === 1 ? '1 day streak' : `${n} day streak`);
const leadText = computed(() => {
  const s = summary.value;
  if (!s.leader) return s.people.a.km === 0 ? 'Nobody has logged km this week yet.' : 'Level this week.';
  return `${store.names[s.leader]} leads this week by ${formatKm(s.lead)} km.`;
});
</script>

<template>
  <section class="card card--hero stack" aria-label="Scoreboard">
    <div class="compare">
      <div v-for="p in PERSONS" :key="p" class="compare__col" :class="`compare__col--${p}`">
        <div class="compare__name"><span class="dot" :class="`dot--${p}`"></span><span class="truncate">{{ store.names[p] }}</span></div>
        <div class="compare__value">{{ formatPoints(scoreboard[p].points) }}</div>
        <div class="compare__label">points</div>
        <div class="progress" :class="`progress--${p}`" role="progressbar" :aria-valuenow="scoreboard[p].planPct" aria-valuemin="0" aria-valuemax="100" :aria-label="`${store.names[p]}: ${scoreboard[p].planPct}% of planned km`" :style="{ '--value': scoreboard[p].planPct }">
          <div class="progress__bar"></div>
        </div>
        <div class="compare__sub">{{ formatKm(scoreboard[p].km) }} km · {{ scoreboard[p].planPct }}% of plan</div>
        <div class="compare__sub">🔥 {{ streakText(scoreboard[p].streak) }}</div>
        <div class="compare__sub"><span aria-hidden="true">🔥</span> <strong class="text-strong">{{ weekStreakText(weekStreaks[p].current) }}</strong></div>
        <div class="compare__sub">{{ thisWeekRunsText(weekStreaks[p].thisWeek) }}<template v-if="weekStreaks[p].thisWeek.met && !weekStreaks[p].thisWeek.paused"><span aria-hidden="true"> ✓</span><span class="sr-only">, target met</span></template></div>
      </div>
    </div>

    <div class="stack stack--sm">
      <div class="section-header">
        <h2 class="section-title">This week</h2>
        <span class="text-sm text-muted">{{ summary.week ? `Plan week ${summary.week.n}` : 'Outside the plan' }}</span>
      </div>
      <div v-for="p in PERSONS" :key="p" class="h2h-row">
        <span class="h2h-row__name"><span class="dot" :class="`dot--${p}`"></span><span class="truncate">{{ store.names[p] }}</span></span>
        <div v-if="summary.people[p].pct != null" class="progress progress--sm" :class="`progress--${p}`" role="progressbar" :aria-valuenow="summary.people[p].pct" aria-valuemin="0" aria-valuemax="100" :aria-label="`${store.names[p]}: ${summary.people[p].pct}% of this week's planned km`" :style="{ '--value': summary.people[p].pct }">
          <div class="progress__bar"></div>
        </div>
        <span v-else class="text-xs text-muted">no plan</span>
        <span class="h2h-row__value">
          <strong class="text-strong">{{ formatKm(summary.people[p].km) }} km</strong>
          <span v-if="summary.people[p].pct != null" class="text-muted"> · {{ summary.people[p].pct }}%</span>
        </span>
      </div>
      <p class="text-sm text-muted">{{ leadText }}</p>
    </div>
  </section>
</template>
