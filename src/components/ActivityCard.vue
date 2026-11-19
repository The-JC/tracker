<script setup>
// ActivityCard: one Strava-style feed card.
// Props: entry (ActivityEntry, required). Emits: 'edit' (own entries: the Edit button; the parent opens the edit sheet).
// Calls toggleKudos / deleteActivity / loadPhoto from the store directly.
// The photo is fetched lazily (IntersectionObserver) only when entry.hasPhoto; imported legacy entries render compact.
import { ref, computed, watch, onMounted, onBeforeUnmount, nextTick } from 'vue';
import { store, today, toggleKudos, deleteActivity, loadPhoto, pushToast, rollingViews } from '../store.js';
import { explainMatch } from '../rolling.js';
import { pointsFor, paceMinPerKm, formatPace, formatKm, relativeDate } from '../scoring.js';
import { SPORT_BY_KEY, RUN_TYPE_BY_KEY } from '../plan.js';

const props = defineProps({ entry: { type: Object, required: true } });
const emit = defineEmits(['edit']);

const e = computed(() => props.entry);
const person = computed(() => (e.value.person === 'b' ? 'b' : 'a'));
const name = computed(() => store.names[person.value] || '');
const isMine = computed(() => e.value.person === store.me);
const other = computed(() => (person.value === 'a' ? 'b' : 'a'));
const sport = computed(() => SPORT_BY_KEY[e.value.sport] || { label: 'Activity', emoji: '🏅' });
const when = computed(() => relativeDate(e.value.date, today.value) || (e.value.week ? `Week ${e.value.week}` : 'Imported'));
const runType = computed(() => (e.value.sport === 'run' ? RUN_TYPE_BY_KEY[e.value.runType] : null));
const compact = computed(() => !!e.value.imported);
// Flexible plan: which session a run counts for ('Counts for Tempo, Week 7' / 'Free run').
const matchLine = computed(() => {
  const v = e.value.sport === 'run' && e.value.km > 0 ? rollingViews.value[person.value] : null;
  return v ? explainMatch(e.value.id, v.match, v.sessions) : '';
});

/* ---------- stats: only those that exist ---------- */

// 45 min -> { value:'45', unit:'min' }, 65 min -> { value:'1:05', unit:'h' }
function durationParts(min) {
  const total = Math.round(min);
  if (total < 60) return { value: String(total), unit: 'min' };
  return { value: `${Math.floor(total / 60)}:${String(total % 60).padStart(2, '0')}`, unit: 'h' };
}

const stats = computed(() => {
  const en = e.value;
  const out = [];
  if (en.km > 0) out.push({ key: 'km', value: formatKm(Number(en.km)), unit: 'km', label: 'Distance' });
  if (en.durationMin > 0) {
    const d = durationParts(Number(en.durationMin));
    out.push({ key: 'time', value: d.value, unit: d.unit, label: 'Time' });
  }
  const pace = paceMinPerKm(en);
  if (pace !== null) out.push({ key: 'pace', value: formatPace(pace), unit: '', label: 'Pace /km' }); // unit in the label: 4 stats must fit 390px
  out.push({ key: 'pts', value: formatKm(pointsFor(en)), unit: '', label: 'Points', accent: true });
  return out;
});

/* ---------- photo: lazy, only when the card is near the viewport ---------- */

const photo = ref(null);
const photoState = ref(e.value.hasPhoto ? 'idle' : 'none'); // none | idle | loading | ready | failed
const mediaEl = ref(null);
let observer = null;

async function fetchPhoto() {
  if (photoState.value === 'loading' || photoState.value === 'ready') return;
  photoState.value = 'loading';
  const url = await loadPhoto(e.value.id);
  if (url) { photo.value = url; photoState.value = 'ready'; } else photoState.value = 'failed';
}

onMounted(() => {
  if (!e.value.hasPhoto || !mediaEl.value) return;
  if (typeof IntersectionObserver === 'undefined') { fetchPhoto(); return; }
  observer = new IntersectionObserver(items => {
    if (items.some(i => i.isIntersecting)) { observer.disconnect(); observer = null; fetchPhoto(); }
  }, { rootMargin: '300px 0px' });
  observer.observe(mediaEl.value);
});
// An edit may add, replace or remove the photo: reload it (the store keeps its cache current).
watch(() => [e.value.hasPhoto, e.value.editedTs], ([has]) => {
  if (!has) { photo.value = null; photoState.value = 'none'; return; }
  photo.value = null;
  photoState.value = 'idle';
  fetchPhoto();
});
onBeforeUnmount(() => { if (observer) observer.disconnect(); document.removeEventListener('keydown', onViewerKey); });

/* ---------- full-screen viewer ---------- */

const viewer = ref(false);
const closeBtn = ref(null);
const mediaBtn = ref(null);

function onViewerKey(ev) { if (ev.key === 'Escape') closeViewer(); }
async function openViewer() {
  viewer.value = true;
  document.addEventListener('keydown', onViewerKey);
  await nextTick();
  if (closeBtn.value) closeBtn.value.focus();
}
function closeViewer() {
  viewer.value = false;
  document.removeEventListener('keydown', onViewerKey);
  if (mediaBtn.value) mediaBtn.value.focus({ preventScroll: true });
}

/* ---------- kudos + delete ---------- */

const kudosCount = computed(() => Object.keys(e.value.kudos || {}).length);
const iGaveKudos = computed(() => !!(store.me && e.value.kudos && e.value.kudos[store.me]));
const otherGaveKudos = computed(() => !!(e.value.kudos && e.value.kudos[other.value]));
const kudosBusy = ref(false);

async function kudos() {
  if (kudosBusy.value) return;
  kudosBusy.value = true;
  try { await toggleKudos(e.value.id); } catch (err) { pushToast("Couldn't send kudos. Check your connection.", 'danger'); }
  kudosBusy.value = false;
}

const confirming = ref(false);
const deleting = ref(false);
const deleteBtn = ref(null);
const confirmBtn = ref(null);
watch(confirming, async c => {
  await nextTick();
  if (c && confirmBtn.value) confirmBtn.value.focus();
});

async function remove() {
  deleting.value = true;
  try { await deleteActivity(e.value.id); } catch (err) {
    deleting.value = false;
    confirming.value = false;
    pushToast("Couldn't delete the activity. Check your connection.", 'danger');
  }
}
function cancelDelete() {
  confirming.value = false;
  nextTick(() => deleteBtn.value && deleteBtn.value.focus());
}
</script>

<template>
  <article class="card activity-card" :class="[`activity-card--${person}`, { 'activity-card--compact': compact }]">
    <header class="activity-card__header">
      <span class="avatar" :class="`avatar--${person}`" aria-hidden="true">{{ name.charAt(0).toUpperCase() }}</span>
      <div class="activity-card__who">
        <span class="activity-card__name">{{ name }}</span>
        <span class="activity-card__time">{{ when }}<template v-if="entry.editedTs"> · edited</template></span>
      </div>
      <span class="activity-card__sport" role="img" :aria-label="sport.label">{{ sport.emoji }}</span>
    </header>

    <div class="activity-card__body">
      <h3 class="activity-card__title">{{ entry.title }}</h3>
      <p v-if="entry.note" class="activity-card__note">{{ entry.note }}</p>
      <p v-if="matchLine" class="text-sm text-muted" data-testid="match-line">{{ matchLine }}</p>
      <div v-if="runType || compact" class="activity-card__tags">
        <span v-if="runType" class="tag tag--accent">{{ runType.name }} ×{{ runType.mult }}</span>
        <span v-if="compact" class="tag">Imported</span>
      </div>
    </div>

    <div class="activity-card__stats stat-row stat-row--divided">
      <div v-for="s in stats" :key="s.key" class="stat" :class="{ 'stat--a': s.accent && person === 'a', 'stat--b': s.accent && person === 'b' }">
        <span class="stat__value num">{{ s.value }}<span v-if="s.unit" class="stat__unit">{{ s.unit }}</span></span>
        <span class="stat__label">{{ s.label }}</span>
      </div>
    </div>

    <figure v-if="photoState !== 'none'" ref="mediaEl" class="activity-card__media">
      <button v-if="photoState === 'ready'" ref="mediaBtn" type="button" class="feed-photo-btn" :aria-label="`View photo from ${entry.title}`" @click="openViewer">
        <img :src="photo" :alt="`Photo from ${entry.title}`" loading="lazy" decoding="async">
      </button>
      <p v-else-if="photoState === 'failed'" class="feed-photo-fallback text-faint text-sm">
        Photo unavailable.
        <button type="button" class="btn btn--ghost btn--sm" @click="fetchPhoto">Try again</button>
      </p>
      <div v-else class="skeleton skeleton--media feed-photo-skeleton" role="status" aria-label="Loading photo"></div>
    </figure>

    <footer class="activity-card__actions">
      <template v-if="!isMine">
        <button type="button" class="kudos-btn" :class="{ 'is-active': iGaveKudos }" :aria-pressed="iGaveKudos" :aria-label="`Give kudos to ${name}`" :disabled="kudosBusy" @click="kudos">
          <span class="kudos-btn__icon" aria-hidden="true">👏</span>
          <span class="kudos-btn__count">{{ kudosCount }}</span>
        </button>
      </template>
      <span v-else-if="otherGaveKudos && !confirming" class="activity-card__kudos-who"><span aria-hidden="true">👏</span> Kudos from {{ store.names[other] }}</span>

      <div v-if="isMine" class="activity-card__actions-end">
        <template v-if="confirming">
          <span class="text-sm text-muted" role="alert">Delete this activity?</span>
          <button type="button" class="btn btn--ghost btn--sm" :disabled="deleting" @click="cancelDelete">Cancel</button>
          <button ref="confirmBtn" type="button" class="btn btn--danger btn--sm" :class="{ 'is-loading': deleting }" :disabled="deleting" @click="remove">Delete</button>
        </template>
        <template v-else>
          <button type="button" class="btn btn--ghost btn--sm" aria-label="Edit activity" @click="emit('edit', entry)">
            <svg class="icon icon--sm" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M4 20h4L19 9a2.8 2.8 0 0 0-4-4L4 16z" /><path d="M13.5 6.5l4 4" /></svg>
            Edit
          </button>
          <button ref="deleteBtn" type="button" class="btn btn--danger-ghost btn--sm" @click="confirming = true">Delete</button>
        </template>
      </div>
    </footer>

    <Teleport to="body">
      <div v-if="viewer" class="photo-viewer" role="dialog" aria-modal="true" :aria-label="`Photo from ${entry.title}`" @click.self="closeViewer">
        <img :src="photo" :alt="`Photo from ${entry.title}`" class="photo-viewer__img">
        <button ref="closeBtn" type="button" class="btn btn--secondary btn--icon btn--round photo-viewer__close" aria-label="Close photo" @click="closeViewer">
          <svg class="icon" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" aria-hidden="true"><path d="M6 6l12 12M18 6L6 18" /></svg>
        </button>
      </div>
    </Teleport>
  </article>
</template>
