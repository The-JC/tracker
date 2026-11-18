// Detects a newer deployed version and exposes it to the UI (UpdateBanner, Settings).
import { ref } from 'vue';
import { CHECK_INTERVAL_MS, isNewVersion, fetchRemoteBuild, shouldCheck } from './updateCheck.js';

export const APP_BUILD = typeof __APP_BUILD__ !== 'undefined' ? __APP_BUILD__ : 'dev';

export const updateAvailable = ref(false);
export const checkingUpdate = ref(false);
export const lastCheckResult = ref(''); // '' | 'current' | 'available' | 'failed' (for the manual check in Settings)

let lastCheck = 0;
let started = false;

export async function checkForUpdate({ force = false } = {}) {
  if (updateAvailable.value || APP_BUILD === 'dev') return updateAvailable.value;
  if (!shouldCheck({ now: Date.now(), last: lastCheck, force })) return false;
  lastCheck = Date.now();
  checkingUpdate.value = true;
  try {
    const remote = await fetchRemoteBuild({ url: `${import.meta.env.BASE_URL}version.json` });
    if (remote === null) { lastCheckResult.value = 'failed'; return false; }
    updateAvailable.value = isNewVersion(APP_BUILD, remote);
    lastCheckResult.value = updateAvailable.value ? 'available' : 'current';
    return updateAvailable.value;
  } finally {
    checkingUpdate.value = false;
  }
}

// Reload from the network. The service worker caches nothing, but ask it to update too so a changed sw.js is picked up.
export async function reloadApp() {
  try {
    const reg = 'serviceWorker' in navigator ? await navigator.serviceWorker.getRegistration() : null;
    if (reg) await reg.update();
  } catch (e) { /* ignore */ }
  location.reload();
}

export function startUpdateChecks() {
  if (started || typeof window === 'undefined' || APP_BUILD === 'dev') return;
  started = true;
  checkForUpdate({ force: true });
  setInterval(() => { if (document.visibilityState === 'visible') checkForUpdate(); }, CHECK_INTERVAL_MS);
  document.addEventListener('visibilitychange', () => { if (document.visibilityState === 'visible') checkForUpdate(); });
  window.addEventListener('online', () => checkForUpdate());
  // After a deploy the old hashed chunks are gone: a lazy view that fails to load means we are running stale code.
  window.addEventListener('vite:preloadError', event => { event.preventDefault(); updateAvailable.value = true; });
}
