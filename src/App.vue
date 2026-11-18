<script setup>
// App shell: auth gate (Google sign-in; identity comes from the account) -> appbar / tab views / tab bar / sheets / toasts.
// Tabs are synced with location.hash ('#/feed', '#/plan', '#/stats', '#/notes'); each tab keeps its scroll position.
// Heavy, rarely-first views are lazy chunks (defineAsyncComponent) so first paint stays small.
import { ref, computed, watch, nextTick, onMounted, onBeforeUnmount, defineAsyncComponent } from 'vue';
import { store } from './store.js';
import { unseenNotes, badgeText } from './viewmodels.js';
import AuthGate from './components/AuthGate.vue';
import ToastHost from './components/ToastHost.vue';
import NotificationBell from './components/NotificationBell.vue';
import Scoreboard from './components/Scoreboard.vue';
import FeedView from './components/FeedView.vue';
import LogActivitySheet from './components/LogActivitySheet.vue';

const PlanView = defineAsyncComponent(() => import('./components/PlanView.vue'));
const StatsView = defineAsyncComponent(() => import('./components/StatsView.vue'));
const NotesView = defineAsyncComponent(() => import('./components/NotesView.vue'));
const SettingsSheet = defineAsyncComponent(() => import('./components/SettingsSheet.vue'));

// Left of the record button: feed, plan. Right of it: stats, notes.
const TABS = [
  { key: 'feed', label: 'Feed', icon: 'i-feed' },
  { key: 'plan', label: 'Plan', icon: 'i-plan' },
  { key: 'stats', label: 'Stats', icon: 'i-stats' },
  { key: 'notes', label: 'Notes', icon: 'i-notes' }
];
const VIEWS = { feed: FeedView, plan: PlanView, stats: StatsView, notes: NotesView };

const fromHash = () => {
  const k = location.hash.replace(/^#\/?/, '');
  return TABS.some(t => t.key === k) ? k : 'feed';
};
const tab = ref(fromHash());
const view = computed(() => VIEWS[tab.value]);
const tabLabel = computed(() => TABS.find(t => t.key === tab.value).label);
const logOpen = ref(false);
const settingsOpen = ref(false);
const settingsLoaded = ref(false); // mount the lazy sheet on first open, then keep it so it can animate out
const openSettings = () => { settingsLoaded.value = true; settingsOpen.value = true; };

const meName = computed(() => (store.me ? store.names[store.me] : ''));
const meInitial = computed(() => (meName.value ? meName.value.charAt(0).toUpperCase() : '?'));
const photoOk = ref(true);
watch(() => store.user && store.user.photoURL, () => { photoOk.value = true; });

/* ---- tabs: hash sync + per-tab scroll position ---- */
const scrollPos = {};
const onHash = () => { tab.value = fromHash(); };
onMounted(() => window.addEventListener('hashchange', onHash));
onBeforeUnmount(() => window.removeEventListener('hashchange', onHash));

watch(tab, (t, old) => {
  scrollPos[old] = window.scrollY;
  if (fromHash() !== t) history.replaceState(null, '', `#/${t}`);
  nextTick(() => window.scrollTo(0, scrollPos[t] || 0));
}, { flush: 'pre' });
const go = key => { if (tab.value === key) window.scrollTo({ top: 0, behavior: 'smooth' }); else tab.value = key; };

/* ---- Notes tab badge: notes by the other person since the Notes tab was last open ---- */
const SEEN_KEY = 'trailhead-notes-seen';
const readSeen = () => {
  try { const v = Number(localStorage.getItem(SEEN_KEY)); if (localStorage.getItem(SEEN_KEY) !== null && Number.isFinite(v)) return v; } catch (e) { /* ignore */ }
  return Date.now(); // first run on this device: existing notes count as seen
};
const notesSeen = ref(readSeen());
const markNotesSeen = () => {
  const newest = store.notes.reduce((m, n) => Math.max(m, n.ts || 0), 0);
  notesSeen.value = Math.max(Date.now(), newest);
  try { localStorage.setItem(SEEN_KEY, String(notesSeen.value)); } catch (e) { /* ignore */ }
};
const notesBadge = computed(() => (tab.value === 'notes' ? 0 : unseenNotes(store.notes, store.me, notesSeen.value)));
watch([tab, () => store.notes.length], () => { if (tab.value === 'notes') markNotesSeen(); }, { immediate: true });
</script>

<template>
  <div v-if="store.authState === 'loading'" class="gate">
    <div class="gate__box">
      <h1 class="gate__title">Trailhead</h1>
      <p class="gate__text" role="status">Loading…</p>
      <span class="skeleton skeleton--text" aria-hidden="true"></span>
    </div>
  </div>
  <AuthGate v-else-if="store.authState !== 'signedIn'" />
  <template v-else>
    <header class="appbar">
      <div class="appbar__inner">
        <div class="appbar__brand">
          <span class="appbar__kicker">Trailhead</span>
          <span class="appbar__title">{{ tabLabel }}</span>
        </div>
        <div class="appbar__actions">
          <NotificationBell />
          <button type="button" class="btn btn--ghost btn--icon btn--round" :aria-label="`Settings, signed in as ${meName}`" @click="openSettings">
            <span class="avatar avatar--sm" :class="store.me ? `avatar--${store.me}` : ''">
              <img v-if="store.user && store.user.photoURL && photoOk" :src="store.user.photoURL" alt="" referrerpolicy="no-referrer" @error="photoOk = false">
              <template v-else>{{ meInitial }}</template>
            </span>
          </button>
        </div>
      </div>
    </header>

    <main class="container app-main stack stack--lg">
      <div v-if="store.backend === 'firebase' && (!store.online || store.syncError)" class="banner banner--warning" role="status">
        <span class="banner__icon"><svg class="icon" aria-hidden="true"><use href="#i-alert" /></svg></span>
        <div class="banner__body">
          <div class="banner__title">{{ store.online ? 'Sync problem' : 'You are offline' }}</div>
          <div class="banner__text">{{ store.online ? store.syncError : 'Changes are kept on this device and sent as soon as you are back online.' }}</div>
        </div>
      </div>
      <Scoreboard v-if="tab === 'feed'" />
      <KeepAlive>
        <component :is="view" @log="logOpen = true" />
      </KeepAlive>
    </main>

    <nav class="tabbar" aria-label="Main">
      <div class="tabbar__inner">
        <button v-for="t in TABS.slice(0, 2)" :key="t.key" type="button" class="tabbar__item" :class="{ 'is-active': tab === t.key }" :aria-current="tab === t.key ? 'page' : null" @click="go(t.key)">
          <svg class="icon tabbar__icon" aria-hidden="true"><use :href="`#${t.icon}`" /></svg>
          <span class="tabbar__label">{{ t.label }}</span>
        </button>
        <button type="button" class="tabbar__record" aria-label="Log activity" @click="logOpen = true">
          <svg class="icon" aria-hidden="true"><use href="#i-plus" /></svg>
        </button>
        <button v-for="t in TABS.slice(2)" :key="t.key" type="button" class="tabbar__item" :class="{ 'is-active': tab === t.key }" :aria-current="tab === t.key ? 'page' : null" @click="go(t.key)">
          <svg class="icon tabbar__icon" aria-hidden="true"><use :href="`#${t.icon}`" /></svg>
          <span class="tabbar__label">{{ t.label }}</span>
          <span v-if="t.key === 'notes' && notesBadge" class="badge badge--count tabbar__badge" :aria-label="`${notesBadge} new notes`">{{ badgeText(notesBadge) }}</span>
        </button>
      </div>
    </nav>

    <LogActivitySheet :open="logOpen" @close="logOpen = false" />
    <SettingsSheet v-if="settingsLoaded" :open="settingsOpen" @close="settingsOpen = false" />
  </template>
  <ToastHost />
</template>
