<script setup>
// ToastHost: renders store.toasts ([{id,text,kind,actor?}]); dismissToast(id) removes one (auto-dismiss is done by the store).
// Props: none. Emits: none. Event toasts (activity/kudos/week/note) are coloured by the actor (--a / --b);
// status toasts use their own modifier. role=status / aria-live=polite on the host, role=alert for errors.
import { store, dismissToast } from '../store.js';
import { toastView } from '../viewmodels.js';

const view = t => toastView(t);
</script>

<template>
  <TransitionGroup name="toast" tag="div" class="toast-host" role="status" aria-live="polite">
    <div v-for="t in store.toasts" :key="t.id" class="toast" :class="view(t).modifier && `toast--${view(t).modifier}`" :role="view(t).role === 'alert' ? 'alert' : undefined">
      <span class="toast__icon" aria-hidden="true">
        <template v-if="view(t).emoji">{{ view(t).emoji }}</template>
        <svg v-else class="icon"><use :href="`#${view(t).icon}`" /></svg>
      </span>
      <div class="toast__body">
        <div class="toast__text toast__text--main text-sm">{{ view(t).text }}</div>
      </div>
      <button type="button" class="toast__close btn btn--ghost btn--icon btn--sm" aria-label="Dismiss notification" @click="dismissToast(t.id)">
        <svg class="icon icon--sm" aria-hidden="true"><use href="#i-x" /></svg>
      </button>
    </div>
  </TransitionGroup>
</template>
