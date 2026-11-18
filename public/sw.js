// Service worker: Web Push + notification clicks. It deliberately caches nothing (app files are always fetched fresh).
// skipWaiting/claim make a new version of this file take over immediately.
self.addEventListener('install', () => self.skipWaiting());
self.addEventListener('activate', event => event.waitUntil(self.clients.claim()));

const isIOS = () => /iPhone|iPad|iPod/.test((self.navigator && self.navigator.userAgent) || '');

// Push payload from the Worker: JSON {title, body, tag, url}; plain text is accepted as the body.
function parsePush(event) {
  if (!event.data) return {};
  try { return event.data.json() || {}; } catch (e) { /* not JSON */ }
  try { return { body: event.data.text() }; } catch (e) { return {}; }
}

// "/" or empty (what the Worker sends) means "this app", i.e. the service worker scope, so sub-path hosting works.
function targetUrl(url) {
  const scope = self.registration.scope;
  if (!url || url === '/') return scope;
  try { return new URL(url, scope).href; } catch (e) { return scope; }
}

self.addEventListener('push', event => {
  const d = parsePush(event);
  const icon = new URL('icon.svg', self.registration.scope).href;
  event.waitUntil((async () => {
    // The in-app toast already covers a visible window. Exception iOS: Safari requires every push to show a
    // notification and may revoke the subscription after silent ones, so there we always show it.
    if (!isIOS()) {
      const wins = await self.clients.matchAll({ type: 'window', includeUncontrolled: true });
      if (wins.some(c => c.visibilityState === 'visible')) return;
    }
    await self.registration.showNotification(d.title || 'Trailhead', {
      body: d.body || '', tag: d.tag || undefined, icon, badge: icon, data: { url: targetUrl(d.url) }
    });
  })());
});

self.addEventListener('notificationclick', event => {
  event.notification.close();
  const target = targetUrl(event.notification.data && event.notification.data.url);
  event.waitUntil((async () => {
    const all = await self.clients.matchAll({ type: 'window', includeUncontrolled: true });
    for (const c of all) {
      if (c.url.startsWith(self.registration.scope) && 'focus' in c) return c.focus();
    }
    return self.clients.openWindow(target);
  })());
});

// Best effort only: the browser rotated or dropped the subscription. We cannot write to the database from here
// (no auth), so just ask open pages to re-sync; otherwise the next sign-in re-stores it. Errors are ignored.
self.addEventListener('pushsubscriptionchange', event => {
  event.waitUntil((async () => {
    try {
      const all = await self.clients.matchAll({ type: 'window', includeUncontrolled: true });
      all.forEach(c => c.postMessage({ type: 'trailhead-push-resync' }));
    } catch (e) { /* ignore */ }
  })());
});
