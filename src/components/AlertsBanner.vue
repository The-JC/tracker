<script setup>
// AlertsBanner: explains and controls system notifications (store.notifPermission, store.pushActive). Used by the bell panel and Settings.
// Props: showGranted (also show the "on" line with a turn-off button). Emits: none.
// States: Home Screen hint (iOS, not installed) · unsupported · denied · off/ready (enable button) · active.
import { computed } from 'vue';
import { store, enableSystemNotifications, disableSystemNotifications } from '../store.js';
import { isPushSupported, needsHomeScreen } from '../push.js';

defineProps({ showGranted: { type: Boolean, default: false } });

const homeScreen = needsHomeScreen();
const supported = isPushSupported();
const real = computed(() => store.backend === 'firebase'); // the local demo backend has no real push
const state = computed(() => {
  if (homeScreen) return 'homescreen';
  if (!supported || store.notifPermission === 'unsupported') return 'unsupported';
  if (store.notifPermission === 'denied') return 'denied';
  if (store.notifPermission === 'granted' && store.pushBusy && !store.pushActive) return 'busy'; // silent re-sync running: avoid flicker
  if (store.notifPermission === 'granted' && store.pushActive) return 'active';
  if (store.notifPermission === 'granted' && !real.value) return 'local';
  return 'off'; // 'default', or granted but turned off / not subscribed yet
});

const EXPLAIN = 'Get a notification on this device when the other person logs something, even when the app is closed. On iPhone: first add the app to your Home Screen (Share → Add to Home Screen), then enable here.';
</script>

<template>
  <div v-if="state === 'homescreen'" class="banner">
    <span class="banner__icon"><svg class="icon" aria-hidden="true"><use href="#i-info" /></svg></span>
    <div class="banner__body">
      <div class="banner__title">Add to Home Screen to get alerts</div>
      <div class="banner__text">On iPhone and iPad, notifications only work for the installed app. Tap Share, then Add to Home Screen, open Trailhead from there and enable alerts. Notifications inside the app work either way.</div>
    </div>
  </div>
  <div v-else-if="state === 'unsupported'" class="banner">
    <span class="banner__icon"><svg class="icon" aria-hidden="true"><use href="#i-info" /></svg></span>
    <div class="banner__body"><div class="banner__text">This browser can't show system notifications. Notifications inside the app still work. Try Chrome, Edge, Firefox or Safari 16.4+ (iPhone: from the Home Screen).</div></div>
  </div>
  <div v-else-if="state === 'denied'" class="banner banner--warning">
    <span class="banner__icon"><svg class="icon" aria-hidden="true"><use href="#i-alert" /></svg></span>
    <div class="banner__body">
      <div class="banner__title">Alerts are blocked</div>
      <div class="banner__text">Allow notifications for this site in your browser or system settings (on iPhone: Settings → Notifications → Trailhead), then reload the app and enable alerts here. Notifications inside the app still work.</div>
    </div>
  </div>
  <div v-else-if="state === 'off'" class="banner">
    <span class="banner__icon"><svg class="icon" aria-hidden="true"><use href="#i-bell" /></svg></span>
    <div class="banner__body">
      <div class="banner__title">Get alerts on this device</div>
      <div class="banner__text">{{ EXPLAIN }}</div>
    </div>
    <button type="button" class="banner__action btn btn--secondary btn--sm" :disabled="store.pushBusy" @click="enableSystemNotifications">Enable alerts</button>
  </div>
  <div v-else-if="state === 'active' && showGranted" class="row">
    <p class="grow text-sm text-success">Alerts are on for this device, even when the app is closed.</p>
    <button type="button" class="btn btn--secondary btn--sm" :disabled="store.pushBusy" @click="disableSystemNotifications">Turn off</button>
  </div>
  <p v-else-if="state === 'local' && showGranted" class="text-sm text-success">System alerts are on while the app is open (demo mode, no push).</p>
</template>
