// Pure helpers for "a newer version of the app is on the server".
// Every build gets a unique id (see vite.config.js) that is baked into the bundle and also published as /version.json.

export const CHECK_INTERVAL_MS = 5 * 60 * 1000; // background poll while the app is visible
export const MIN_GAP_MS = 30 * 1000;             // never hit the server more often than this (focus/visibility events)

// 'dev' (vite dev server) never reports an update; an unknown/empty remote id is ignored.
export function isNewVersion(current, remote) {
  return typeof remote === 'string' && remote !== '' && current !== 'dev' && remote !== current;
}

// Resolves to the build id on the server, or null when it can't be determined (offline, 404, SPA fallback returning HTML).
export async function fetchRemoteBuild({ fetchFn = globalThis.fetch, url = '/version.json', now = Date.now(), timeoutMs = 8000 } = {}) {
  if (!fetchFn) return null;
  const ctrl = typeof AbortController === 'function' ? new AbortController() : null;
  const timer = ctrl ? setTimeout(() => ctrl.abort(), timeoutMs) : null;
  try {
    const res = await fetchFn(`${url}?t=${now}`, { cache: 'no-store', signal: ctrl ? ctrl.signal : undefined });
    if (!res.ok) return null;
    const data = await res.json();
    return data && typeof data.build === 'string' ? data.build : null;
  } catch (e) {
    return null;
  } finally {
    if (timer) clearTimeout(timer);
  }
}

// Whether a check should run now (throttle). `force` is a user-initiated check.
export function shouldCheck({ now, last, force = false, minGap = MIN_GAP_MS }) {
  return force || !last || now - last >= minGap;
}
