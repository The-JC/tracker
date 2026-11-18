<script setup>
// FeedView: activity cards newest first, 20 at a time ("Show more"), empty state, skeleton until the first log snapshot.
// Props: none. Emits: 'log' (header button / empty-state CTA wants the log sheet opened). Reads store.log (already sorted newest first).
import { ref, computed, watch } from 'vue';
import { store, today } from '../store.js';
import { mondayOf } from '../scoring.js';
import ActivityCard from './ActivityCard.vue';

const emit = defineEmits(['log']);
const PAGE = 20;
const shown = ref(PAGE);

const visible = computed(() => store.log.slice(0, shown.value));
const remaining = computed(() => Math.max(0, store.log.length - shown.value));

// The log is date-sorted, so "this week" entries are a prefix. Headings only when that split exists.
const thisWeekCount = computed(() => {
  const monday = mondayOf(today.value);
  let n = 0;
  for (const e of visible.value) { if (e.date && e.date >= monday) n++; else break; }
  return n;
});

watch(() => store.me, () => { shown.value = PAGE; });
</script>

<template>
  <section class="feed-view stack" aria-labelledby="feed-title">
    <div class="section-header">
      <h2 id="feed-title" class="section-title">Activity</h2>
      <button type="button" class="btn btn--primary btn--sm" @click="emit('log')">Log activity</button>
    </div>

    <div v-if="!store.logLoaded" class="stack" role="status" aria-label="Loading activities">
      <div v-for="n in 2" :key="n" class="card stack stack--md" aria-hidden="true">
        <div class="row">
          <span class="skeleton skeleton--avatar"></span>
          <div class="grow stack stack--sm"><span class="skeleton skeleton--text"></span><span class="skeleton skeleton--text feed-skeleton-short"></span></div>
        </div>
        <span class="skeleton skeleton--title"></span>
        <span class="skeleton skeleton--block"></span>
      </div>
    </div>

    <div v-else-if="!store.log.length" class="card">
      <div class="empty-state">
        <div class="empty-state__icon" aria-hidden="true">🏃</div>
        <h3 class="empty-state__title">No activities yet</h3>
        <p class="empty-state__text">Log your first run, hike or workout to start the feed.</p>
        <div class="empty-state__actions">
          <button type="button" class="btn btn--primary" @click="emit('log')">Log activity</button>
        </div>
      </div>
    </div>

    <template v-else>
      <h3 v-if="thisWeekCount" class="text-eyebrow text-faint">This week</h3>
      <template v-for="(e, i) in visible" :key="e.id">
        <h3 v-if="thisWeekCount && i === thisWeekCount" class="text-eyebrow text-faint feed-view__earlier">Earlier</h3>
        <ActivityCard :entry="e" />
      </template>
      <button v-if="remaining" type="button" class="btn btn--secondary btn--block" @click="shown += PAGE">Show more ({{ remaining }})</button>
    </template>
  </section>
</template>
