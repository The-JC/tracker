import { createApp } from 'vue';
import '../css/tokens.css';
import '../css/base.css';
import '../css/components.css';
import '../css/views-feed.css';
import '../css/views-plan.css';
import App from './App.vue';
import { initStore } from './store.js';
import { startUpdateChecks } from './utils/useUpdateCheck.js';

initStore();
createApp(App).mount('#app');
startUpdateChecks();

// Service worker: only needed for system notifications; needs https (or localhost). Failures are ignored.
if ('serviceWorker' in navigator && (location.protocol === 'https:' || location.hostname === 'localhost' || location.hostname === '127.0.0.1')) {
  window.addEventListener('load', () => {
    navigator.serviceWorker.register(`${import.meta.env.BASE_URL}sw.js`).catch(() => {});
  });
}
