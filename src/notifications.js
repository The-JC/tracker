// Notification logic. The top half is pure (node-tested); the bottom half touches browser APIs
// only inside functions, so importing this module in node is safe.
import { SPORT_BY_KEY } from './plan.js';
import { formatKm } from './scoring.js';

export const BASE_TITLE = 'Trailhead — Half Marathon Tracker';
export const LAST_READ_KEY = 'trailhead-last-read';

/* ---------- event text (stored in the event at creation time) ---------- */

const NOUN = { run: 'run', hike: 'hike', cycle: 'ride', swim: 'swim', strength: 'strength session', workout: 'workout' };

// "8.2 km run", "45 min swim"
export function describeEntry(entry) {
  const sport = SPORT_BY_KEY[entry.sport];
  const noun = NOUN[entry.sport] || 'activity';
  if (sport && sport.requires === 'km' && entry.km > 0) return `${formatKm(entry.km)} km ${noun}`;
  if (entry.durationMin > 0) return `${formatKm(entry.durationMin)} min ${noun}`;
  return noun;
}

// "an 8.2 km run", "an 11 km hike", "a 45 min swim" (integer part 8, 80-89, 11, 18 are read with a vowel).
const article = s => (/^(8\d?|11|18)$/.test(s.split(/[ .]/)[0]) ? 'an' : 'a');

export const activityEventText = (name, entry) => {
  const d = describeEntry(entry);
  return `${name} logged ${article(d)} ${d}`;
};
export const weekEventText = (name, weekN) => `${name} completed week ${weekN} 🎉`;
export const kudosEventText = (name, entry) => `${name} gave kudos to your ${entry.title || describeEntry(entry)}`;
export const noteEventText = (name, text) => {
  const t = String(text || '').trim().replace(/\s+/g, ' ');
  return t ? `${name} posted a note: “${t.length > 60 ? t.slice(0, 57) + '…' : t}”` : `${name} posted a photo note`;
};

/* ---------- unread / new-event logic ---------- */

// Events by the other person newer than lastReadTs (unread badge). Without an identity nothing is unread.
export function unreadEvents(events, me, lastReadTs) {
  if (!me) return [];
  return (events || []).filter(e => e.actor !== me && (e.ts || 0) > lastReadTs);
}

// Events by the other person that appeared since the previous snapshot (`knownIds` = ids seen before;
// null = this is the first snapshot, so history never floods the user with toasts).
// Id based rather than timestamp based, so clock skew between phones cannot swallow events.
// Events older than everything in the previous snapshot are skipped too: they are not new, they only slid into the
// `limitToLast` window because a newer event was deleted (push ids sort by creation time).
export function freshEvents(events, me, knownIds) {
  if (!me || !knownIds) return [];
  let oldest = null;
  for (const id of knownIds) if (oldest === null || id < oldest) oldest = id;
  return (events || []).filter(e => e.actor !== me && !knownIds.has(e.id) && (oldest === null || e.id > oldest));
}

// New lastReadTs after "mark all read": never behind the newest event, even with skewed clocks.
export function nextLastRead(events, now = Date.now()) {
  return (events || []).reduce((m, e) => Math.max(m, e.ts || 0), now);
}

export const documentTitle = unread => (unread > 0 ? `(${unread}) ${BASE_TITLE}` : BASE_TITLE);

// Toast text: event text plus a small emoji hint by kind (activity: the sport's emoji, looked up via refId).
export function toastFor(event, log = []) {
  let emoji = '';
  if (event.kind === 'activity') {
    const entry = log.find(e => e.id === event.refId);
    emoji = entry && SPORT_BY_KEY[entry.sport] ? SPORT_BY_KEY[entry.sport].emoji : '🏃';
  } else if (event.kind === 'kudos') emoji = '👏';
  else if (event.kind === 'note') emoji = '💬';
  return { text: emoji ? `${event.text} ${emoji}` : event.text, kind: event.kind };
}

// Policy (our call): a system notification is only shown when the page is hidden. While the app is
// visible the in-app toast already informs the user; doubling up is noise. When real Web Push is active
// the service worker shows the notification (also for a hidden-but-alive page), so skip the local one.
export function shouldShowSystemNotification({ permission, hidden, pushActive = false }) {
  return permission === 'granted' && !!hidden && !pushActive;
}

/* ---------- browser side ---------- */

export function currentPermission() {
  if (typeof Notification === 'undefined') return 'unsupported';
  return Notification.permission;
}

// Must be called from a user gesture. Resolves to the resulting permission.
export async function requestPermission() {
  if (typeof Notification === 'undefined') return 'unsupported';
  try {
    const r = await Notification.requestPermission();
    return r || Notification.permission;
  } catch (e) {
    return Notification.permission;
  }
}

// Shows a system notification through the service worker (needed on mobile), falling back to `new Notification`.
export async function showSystemNotification(text, { tag, icon } = {}) {
  if (typeof Notification === 'undefined' || Notification.permission !== 'granted') return false;
  const options = { body: text, tag, icon, badge: icon, data: { url: './' } };
  try {
    const reg = navigator.serviceWorker && (await navigator.serviceWorker.getRegistration());
    if (reg && reg.showNotification) { await reg.showNotification('Trailhead', options); return true; }
  } catch (e) { /* fall through */ }
  try { new Notification('Trailhead', options); return true; } catch (e) { return false; }
}

export function loadLastRead() {
  try {
    const raw = localStorage.getItem(LAST_READ_KEY);
    if (raw !== null && Number.isFinite(Number(raw))) return { value: Number(raw), firstRun: false };
  } catch (e) { /* ignore */ }
  return { value: Date.now(), firstRun: true }; // first-ever load on this device: history counts as read
}

export function saveLastRead(ts) {
  try { localStorage.setItem(LAST_READ_KEY, String(ts)); } catch (e) { /* ignore */ }
}
