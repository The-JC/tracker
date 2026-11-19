<script setup>
// SettingsSheet: signed-in account, display names, link to My plan (PlanSettings.vue), system alerts, daily run reminder, sign out, app version.
// Props: open (boolean). Emits: 'close', 'plan-settings' (open the My plan sheet). Lazy-loaded by App.vue via defineAsyncComponent.
// Identity is the signed-in Google account (store.me, store.user) and cannot be changed here.
import { ref, computed, watch, onBeforeUnmount } from 'vue';
import { store, effectiveStartDate, planStates, setName, setReminder, signOut, sendTestNotification } from '../store.js';
import { PUSH_URL } from '../firebaseConfig.js';
import { formatDateLong } from '../scoring.js';
import { version } from '../../package.json';
import { useSheet } from '../utils/useSheet.js';
import { deviceTimeZone, nextReminderText, isValidTime, roundTime } from '../utils/reminderTime.js';
import AlertsBanner from './AlertsBanner.vue';
import { updateAvailable, checkingUpdate, lastCheckResult, checkForUpdate, reloadApp, APP_BUILD } from '../utils/useUpdateCheck.js';

const props = defineProps({ open: { type: Boolean, default: false } });
const emit = defineEmits(['close', 'plan-settings']);

const panel = ref(null);
const error = ref('');
const photoOk = ref(true);
const close = () => emit('close');
useSheet(() => props.open, panel, close);

const meName = computed(() => (store.me ? store.names[store.me] : ''));
const hasManualStart = computed(() => !!store.settings.startDate);
const ownStart = computed(() => !!(store.me && planStates.value[store.me].startDate));

// Test notifications: the local demo backend stays enabled (shows "Local mode: no real push"); Firebase needs the Worker URL.
const otherName = computed(() => store.names[store.me === 'a' ? 'b' : 'a'] || 'the other person');
const pushConfigured = computed(() => store.backend === 'local' || !!PUSH_URL);
const testTarget = ref('');
const testBusy = computed(() => store.testPush.busy);
const testDisabled = computed(() => !pushConfigured.value || testBusy.value);
function runTest(target) { testTarget.value = target; sendTestNotification(target); }

// Daily reminder: the switch saves at once, the time input after a short pause (and on change/blur). `draft` is the
// time as typed; the store holds the validated, 5-minute-rounded value.
const reminder = computed(() => (store.me ? store.reminders[store.me] : null));
const reminderOn = computed(() => !!(reminder.value && reminder.value.enabled));
const draft = ref(reminder.value ? reminder.value.time : '07:30');
const reminderError = ref('');
const reminderSaved = ref(false);
const reminderTz = deviceTimeZone() || 'UTC';
const clock = ref(Date.now()); // re-evaluates the "Next reminder" line while the sheet stays open
const clockTimer = setInterval(() => { clock.value = Date.now(); }, 30000);
let saveTimer = null;
let savedTimer = null;
const nextText = computed(() => nextReminderText(
  { enabled: reminderOn.value, time: reminder.value ? reminder.value.time : draft.value, tz: reminderTz, lastSentDate: reminder.value && reminder.value.lastSentDate },
  clock.value
));
watch(() => reminder.value && reminder.value.time, t => { if (t && saveTimer === null) draft.value = t; });

async function saveReminder(patch) {
  reminderError.value = '';
  reminderSaved.value = false;
  clearTimeout(savedTimer);
  try {
    const r = await setReminder(patch);
    if (saveTimer === null) draft.value = r.time; // reflect rounding
    reminderSaved.value = true;
    savedTimer = setTimeout(() => { reminderSaved.value = false; }, 2500);
  } catch (e) {
    reminderError.value = e.message || "Couldn't save the reminder.";
  }
}
function flushTime() {
  clearTimeout(saveTimer);
  saveTimer = null;
  if (!isValidTime(draft.value)) { if (reminder.value) draft.value = reminder.value.time; return; } // cleared/partial input: keep the saved time
  const t = roundTime(draft.value);
  if (reminder.value && t === reminder.value.time) { draft.value = t; return; }
  saveReminder({ time: t });
}
function onTimeInput(ev) {
  draft.value = ev.target.value;
  clearTimeout(saveTimer);
  saveTimer = setTimeout(flushTime, 600);
}
function onToggle(ev) {
  const enabled = ev.target.checked;
  const timeOk = isValidTime(draft.value);
  clearTimeout(saveTimer);
  saveTimer = null;
  saveReminder(timeOk ? { enabled, time: roundTime(draft.value) } : { enabled });
}
onBeforeUnmount(() => {
  clearInterval(clockTimer);
  clearTimeout(savedTimer);
  if (saveTimer !== null) flushTime();
});

async function saveName(p, ev) {
  error.value = '';
  try { await setName(p, ev.target.value); } catch (e) { error.value = e.message || "Couldn't save the name."; }
  ev.target.value = store.names[p]; // reflect trimming / fallback to the default
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

          <section class="stack stack--sm" aria-labelledby="settings-plan">
            <h3 id="settings-plan" class="text-eyebrow">My plan</h3>
            <p class="text-sm text-muted">
              Week 1 starts on <strong class="text-strong">{{ formatDateLong(effectiveStartDate) }}</strong><template v-if="!ownStart && !hasManualStart"> (automatic)</template>.
              Start date, race date, weekly target, training days, pauses and the plan mode are all per person.
            </p>
            <button type="button" class="btn btn--secondary btn--block" @click="emit('plan-settings')">Open my plan settings</button>
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
            <div v-if="store.testPush.message && testTarget !== 'reminder'" class="banner" :class="`banner--${store.testPush.kind === 'error' ? 'danger' : store.testPush.kind}`" role="status">
              <span class="banner__icon"><svg class="icon" aria-hidden="true"><use :href="store.testPush.kind === 'success' ? '#i-check' : '#i-alert'" /></svg></span>
              <div class="banner__body"><div class="banner__text">{{ store.testPush.message }}</div></div>
            </div>
          </section>

          <section class="stack stack--sm" aria-labelledby="settings-reminder">
            <h3 id="settings-reminder" class="text-eyebrow">Daily reminder</h3>
            <label class="switch">
              <input class="switch__input" type="checkbox" :checked="reminderOn" :disabled="!store.me" @change="onToggle">
              <span class="switch__track"></span>
              <span class="switch__label">Remind me about my next run</span>
            </label>
            <div class="field">
              <label class="field__label" for="reminder-time">Reminder time</label>
              <input id="reminder-time" class="input" type="time" step="300" :value="draft" :disabled="!store.me" @input="onTimeInput" @change="flushTime">
              <p class="field__hint text-sm text-muted">You get one notification at this time with your recommended run — only on days when there is a run to do and you haven't logged anything yet. Time zone: {{ reminderTz }}.</p>
            </div>
            <p class="text-sm" :class="reminderOn ? 'text-strong' : 'text-muted'" data-testid="reminder-next">{{ nextText }}<span class="text-success" role="status">{{ reminderSaved ? ' · Saved' : '' }}</span></p>
            <div v-if="reminderOn && !store.pushActive" class="banner banner--warning" data-testid="reminder-no-push">
              <span class="banner__icon"><svg class="icon" aria-hidden="true"><use href="#i-alert" /></svg></span>
              <div class="banner__body"><div class="banner__text">Alerts are not enabled on this device — reminders are delivered to devices where alerts are on.</div></div>
            </div>
            <div v-if="reminderError" class="banner banner--danger" role="alert">
              <span class="banner__icon"><svg class="icon" aria-hidden="true"><use href="#i-alert" /></svg></span>
              <div class="banner__body"><div class="banner__text">{{ reminderError }}</div></div>
            </div>
            <button type="button" class="btn btn--secondary" :class="{ 'is-loading': testBusy && testTarget === 'reminder' }" :disabled="testDisabled" @click="runTest('reminder')">Send test reminder now</button>
            <div v-if="store.testPush.message && testTarget === 'reminder'" class="banner" :class="`banner--${store.testPush.kind === 'error' ? 'danger' : store.testPush.kind}`" role="status">
              <span class="banner__icon"><svg class="icon" aria-hidden="true"><use :href="store.testPush.kind === 'success' ? '#i-check' : store.testPush.kind === 'info' ? '#i-info' : '#i-alert'" /></svg></span>
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
