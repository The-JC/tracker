<script setup>
// SettingsSheet: signed-in account, display names, plan start date, system alerts, sign out, app version.
// Props: open (boolean). Emits: 'close'. Lazy-loaded by App.vue via defineAsyncComponent.
// Identity is the signed-in Google account (store.me, store.user) and cannot be changed here.
import { ref, computed } from 'vue';
import { store, effectiveStartDate, setName, setStartDate, signOut, sendTestNotification } from '../store.js';
import { PUSH_URL } from '../firebaseConfig.js';
import { formatDateLong } from '../scoring.js';
import { version } from '../../package.json';
import { useSheet } from '../utils/useSheet.js';
import AlertsBanner from './AlertsBanner.vue';
import { updateAvailable, checkingUpdate, lastCheckResult, checkForUpdate, reloadApp, APP_BUILD } from '../utils/useUpdateCheck.js';

const props = defineProps({ open: { type: Boolean, default: false } });
const emit = defineEmits(['close']);

const panel = ref(null);
const error = ref('');
const photoOk = ref(true);
const close = () => emit('close');
useSheet(() => props.open, panel, close);

const meName = computed(() => (store.me ? store.names[store.me] : ''));
const hasManualStart = computed(() => !!store.settings.startDate);

// Test notifications: the local demo backend stays enabled (shows "Local mode: no real push"); Firebase needs the Worker URL.
const otherName = computed(() => store.names[store.me === 'a' ? 'b' : 'a'] || 'the other person');
const pushConfigured = computed(() => store.backend === 'local' || !!PUSH_URL);
const testTarget = ref('');
const testBusy = computed(() => store.testPush.busy);
const testDisabled = computed(() => !pushConfigured.value || testBusy.value);
function runTest(target) { testTarget.value = target; sendTestNotification(target); }

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
            <h3 id="settings-alerts" class="text-eyebrow">Notifications</h3>
            <AlertsBanner show-granted />
            <p class="text-sm text-muted">Check that push works end to end. After tapping, close the app or lock the phone: the test arrives as a system notification.</p>
            <div class="grid grid--stack-mobile">
              <button type="button" class="btn btn--secondary" :class="{ 'is-loading': testBusy && testTarget === 'self' }" :disabled="testDisabled" @click="runTest('self')">Send test to this device</button>
              <button type="button" class="btn btn--secondary" :class="{ 'is-loading': testBusy && testTarget === 'other' }" :disabled="testDisabled" @click="runTest('other')">Send test to {{ otherName }}</button>
            </div>
            <p v-if="!pushConfigured" class="text-sm text-muted">Push is not configured in this build (VITE_PUSH_URL is empty).</p>
            <div v-if="store.testPush.message" class="banner" :class="`banner--${store.testPush.kind === 'error' ? 'danger' : store.testPush.kind}`" role="status">
              <span class="banner__icon"><svg class="icon" aria-hidden="true"><use :href="store.testPush.kind === 'success' ? '#i-check' : '#i-alert'" /></svg></span>
              <div class="banner__body"><div class="banner__text">{{ store.testPush.message }}</div></div>
            </div>
          </section>

          <section class="stack stack--sm" aria-labelledby="settings-updates">
            <h3 id="settings-updates" class="text-eyebrow">App updates</h3>
            <p class="text-sm text-muted" role="status">
              <template v-if="updateAvailable">A new version is available.</template>
              <template v-else-if="lastCheckResult === 'current'">You are on the latest version.</template>
              <template v-else-if="lastCheckResult === 'failed'">Couldn't check right now. Are you online?</template>
              <template v-else>The app checks for new versions automatically.</template>
            </p>
            <button v-if="updateAvailable" type="button" class="btn btn--primary" @click="reloadApp">Reload now</button>
            <button v-else type="button" class="btn btn--secondary" :class="{ 'is-loading': checkingUpdate }" :disabled="checkingUpdate || APP_BUILD === 'dev'" @click="checkForUpdate({ force: true })">Check for updates</button>
          </section>

          <hr class="divider">
          <button type="button" class="btn btn--danger-ghost btn--block" @click="logOut">Sign out</button>
          <p class="text-xs text-faint text-center">Trailhead v{{ version }} · {{ store.backend === 'local' ? 'local demo data' : 'synced with Firebase' }}</p>
        </div>
      </div>
    </div>
  </Transition>
</template>
