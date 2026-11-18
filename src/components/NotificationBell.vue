<script setup>
// NotificationBell: bell button with unread badge + a sheet listing the other person's events (store.events, newest first).
// Props: none. Emits: none. Uses unreadCount, markEventsRead(), store.lastReadTs, store.notifPermission.
// The panel is teleported to <body> (the app bar's backdrop-filter would otherwise trap position:fixed).
// Unread rows stay highlighted while the panel is open; everything is marked read shortly after opening and on close.
import { ref, computed, watch, onBeforeUnmount } from 'vue';
import { store, unreadCount, markEventsRead } from '../store.js';
import { relativeTime, kindLabel, badgeText } from '../viewmodels.js';
import { useSheet } from '../utils/useSheet.js';
import AlertsBanner from './AlertsBanner.vue';

const open = ref(false);
const panel = ref(null);
const seenTs = ref(0); // lastReadTs at the moment the panel opened
const now = ref(Date.now());
let readTimer = null;
let tick = null;

const items = computed(() => store.events.filter(e => e.actor !== store.me));
const isUnread = e => (e.ts || 0) > seenTs.value;
const unreadLabel = computed(() => (unreadCount.value ? `Notifications, ${unreadCount.value} unread` : 'Notifications'));

function show() { open.value = true; }
function hide() { open.value = false; }

watch(open, o => {
  clearTimeout(readTimer); clearInterval(tick);
  if (o) {
    seenTs.value = store.lastReadTs;
    now.value = Date.now();
    tick = setInterval(() => { now.value = Date.now(); }, 30000);
    readTimer = setTimeout(markEventsRead, 1500);
  } else {
    markEventsRead();
  }
});
onBeforeUnmount(() => { clearTimeout(readTimer); clearInterval(tick); });

useSheet(() => open.value, panel, hide);

// Tapping a row jumps to where it happened.
function go(e) {
  location.hash = e.kind === 'note' ? '#/notes' : '#/feed';
  hide();
}
</script>

<template>
  <button type="button" class="btn btn--ghost btn--icon btn--round" :aria-label="unreadLabel" aria-haspopup="dialog" :aria-expanded="open" @click="show">
    <svg class="icon" aria-hidden="true"><use href="#i-bell" /></svg>
    <span v-if="unreadCount" class="badge badge--count badge--floating" aria-hidden="true">{{ badgeText(unreadCount) }}</span>
  </button>

  <Teleport to="body">
    <Transition name="sheet">
      <div v-if="open" class="sheet">
        <div class="sheet__backdrop" @click="hide"></div>
        <div ref="panel" class="sheet__panel" role="dialog" aria-modal="true" aria-labelledby="notif-title">
          <div class="sheet__handle"></div>
          <header class="sheet__header">
            <h2 id="notif-title" class="sheet__title">Notifications</h2>
            <button type="button" class="btn btn--ghost btn--sm" :disabled="!unreadCount" @click="markEventsRead">Mark all read</button>
            <button type="button" class="btn btn--ghost btn--icon btn--round" aria-label="Close" data-autofocus @click="hide">
              <svg class="icon" aria-hidden="true"><use href="#i-x" /></svg>
            </button>
          </header>
          <div class="sheet__body stack stack--md">
            <AlertsBanner />
            <ul v-if="items.length" class="list list--card notif-list" role="list">
              <li v-for="e in items" :key="e.id" class="list-item list-item--interactive" :class="{ 'is-unread': isUnread(e) }" tabindex="0" @click="go(e)" @keydown.enter.prevent="go(e)" @keydown.space.prevent="go(e)">
                <span class="list-item__leading"><span class="avatar avatar--sm" :class="`avatar--${e.actor}`">{{ (store.names[e.actor] || '?').charAt(0).toUpperCase() }}</span></span>
                <span class="list-item__body">
                  <span class="list-item__title">{{ e.text }}</span>
                  <span class="list-item__subtitle">{{ kindLabel(e.kind) }}</span>
                </span>
                <span class="list-item__trailing">
                  {{ relativeTime(e.ts, now) }}
                  <span v-if="isUnread(e)" class="badge badge--dot" aria-label="Unread"></span>
                </span>
              </li>
            </ul>
            <div v-else class="empty-state">
              <div class="empty-state__icon" aria-hidden="true">🔔</div>
              <h3 class="empty-state__title">Nothing yet</h3>
              <p class="empty-state__text">When {{ store.names[store.me === 'a' ? 'b' : 'a'] }} logs an activity, gives kudos or posts a note, it shows up here.</p>
            </div>
          </div>
        </div>
      </div>
    </Transition>
  </Teleport>
</template>
