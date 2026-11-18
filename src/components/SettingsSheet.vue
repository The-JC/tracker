<script setup>
// SettingsSheet: signed-in account, display names, plan start date, system alerts, sign out, app version.
// Props: open (boolean). Emits: 'close'. Lazy-loaded by App.vue via defineAsyncComponent.
// Identity is the signed-in Google account (store.me, store.user) and cannot be changed here.
import { ref, computed } from 'vue';
import { store, effectiveStartDate, setName, setStartDate, signOut } from '../store.js';
import { formatDateLong } from '../scoring.js';
import { version } from '../../package.json';
import { useSheet } from '../utils/useSheet.js';
import AlertsBanner from './AlertsBanner.vue';

const props = defineProps({ open: { type: Boolean, default: false } });
const emit = defineEmits(['close']);

const panel = ref(null);
const error = ref('');
const photoOk = ref(true);
const close = () => emit('close');
useSheet(() => props.open, panel, close);

const meName = computed(() => (store.me ? store.names[store.me] : ''));
const hasManualStart = computed(() => !!store.settings.startDate);

async function saveName(p, ev) {
  error.value = '';
  try { await setName(p, ev.target.value); } catch (e) { error.value = e.message || "Couldn't save the name."; }
  ev.target.value = store.names[p]; // reflect trimming / fallback to the default
}
async function saveStart(ev) {
  error.value = '';
  try { await setStartDate(ev.target.value || null); } catch (e) { error.value = e.message || 'Invalid date.'; }
}
async function resetStart() {
  error.value = '';
  try { await setStartDate(null); } catch (e) { error.value = e.message || "Couldn't reset the date."; }
}
async function logOut() {
  close();
  await signOut();
}
</script>

<template>
  <Transition name="sheet">
    <div v-if="open" class="sheet">
      <div class="sheet__backdrop" @click="close"></div>
      <div ref="panel" class="sheet__panel" role="dialog" aria-modal="true" aria-labelledby="settings-title">
        <div class="sheet__handle"></div>
        <header class="sheet__header">
          <h2 id="settings-title" class="sheet__title">Settings</h2>
          <button type="button" class="btn btn--ghost btn--icon btn--round" aria-label="Close" @click="close"><svg class="icon" aria-hidden="true"><use href="#i-x" /></svg></button>
        </header>

        <div class="sheet__body stack">
          <div v-if="store.user" class="card card--inset card--flat row">
            <span class="avatar" :class="store.me ? `avatar--${store.me}` : ''">
              <img v-if="store.user.photoURL && photoOk" :src="store.user.photoURL" alt="" referrerpolicy="no-referrer" @error="photoOk = false">
              <template v-else>{{ (meName || '?').charAt(0).toUpperCase() }}</template>
            </span>
            <div class="grow">
              <div class="text-semibold truncate">{{ store.user.displayName || meName }}</div>
              <div class="text-sm text-muted truncate">{{ store.user.email }}</div>
            </div>
            <span v-if="store.me" class="tag" :class="`tag--${store.me}`">You are {{ meName }}</span>
          </div>

          <div v-if="error" class="banner banner--danger" role="alert">
            <span class="banner__icon"><svg class="icon" aria-hidden="true"><use href="#i-alert" /></svg></span>
            <div class="banner__body"><div class="banner__text">{{ error }}</div></div>
          </div>

          <section class="stack stack--sm" aria-labelledby="settings-names">
            <h3 id="settings-names" class="text-eyebrow">Display names</h3>
            <div class="grid grid--stack-mobile">
              <div v-for="p in ['a', 'b']" :key="p" class="field">
                <label class="field__label" :for="`name-${p}`"><span class="dot" :class="`dot--${p}`"></span> Person {{ p.toUpperCase() }}</label>
                <input :id="`name-${p}`" class="input" :value="store.names[p]" maxlength="18" autocomplete="off" @change="saveName(p, $event)">
              </div>
            </div>
            <p class="field__hint text-sm text-muted">Shown on both phones. Leave empty to restore the default.</p>
          </section>

          <section class="stack stack--sm" aria-labelledby="settings-start">
            <h3 id="settings-start" class="text-eyebrow">Plan start date</h3>
            <div class="field">
              <label class="field__label" for="start-date">Week 1 starts on</label>
              <input id="start-date" class="input" type="date" :value="store.settings.startDate || ''" @change="saveStart">
              <p class="field__hint text-sm text-muted">
                Currently <strong class="text-strong">{{ formatDateLong(effectiveStartDate) }}</strong>
                <template v-if="!hasManualStart"> (automatic: the Monday of the first logged run's week)</template>.
              </p>
            </div>
            <div v-if="hasManualStart"><button type="button" class="btn btn--secondary btn--sm" @click="resetStart">Reset to automatic</button></div>
          </section>

          <section class="stack stack--sm" aria-labelledby="settings-alerts">
            <h3 id="settings-alerts" class="text-eyebrow">Alerts</h3>
            <AlertsBanner show-granted />
          </section>

          <hr class="divider">
          <button type="button" class="btn btn--danger-ghost btn--block" @click="logOut">Sign out</button>
          <p class="text-xs text-faint text-center">Trailhead v{{ version }} · {{ store.backend === 'local' ? 'local demo data' : 'synced with Firebase' }}</p>
        </div>
      </div>
    </div>
  </Transition>
</template>
