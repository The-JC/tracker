<script setup>
// AuthGate: shown by App.vue while store.authState is 'signedOut' or 'denied' ('loading' is handled by App.vue).
// Props: none. Emits: none. Calls signInWithGoogle() (popup, redirect fallback happens inside the backend)
// and signOut() ("Use another account" on the denied screen). Reads store.authState, store.authError, store.user
// ({ email, displayName, photoURL }; set while denied so it can show which account was rejected).
// In ?local=1 mode (store.backend === 'local') offers one fake sign-in button per person: signInWithGoogle('a' | 'b').
import { ref } from 'vue';
import { store, signInWithGoogle, signOut } from '../store.js';
import { PEOPLE } from '../firebaseConfig.js';

const busy = ref(false);

async function signIn(localPerson) {
  if (busy.value) return;
  busy.value = true;
  try { await signInWithGoogle(localPerson); } finally { busy.value = false; }
}
</script>

<template>
  <div class="gate">
    <div class="gate__box">
      <span class="text-eyebrow">Trailhead</span>

      <template v-if="store.authState === 'denied'">
        <h1 class="gate__title">Not on the list</h1>
        <div class="banner banner--danger" role="alert">
          <span class="banner__icon"><svg class="icon" aria-hidden="true"><use href="#i-alert" /></svg></span>
          <div class="banner__body">
            <div class="banner__title">{{ store.authError || 'This Google account is not on the allowlist' }}</div>
            <div v-if="store.user && store.user.email" class="banner__text">You signed in as <strong class="text-strong">{{ store.user.email }}</strong>.</div>
          </div>
        </div>
        <p class="gate__text">Only the two tracker accounts can get in. Try again with the right Google account.</p>
        <button type="button" class="btn btn--secondary btn--lg btn--block" @click="signOut">Use another account</button>
      </template>

      <template v-else>
        <h1 class="gate__title">Welcome back</h1>
        <p class="gate__text">Sign in with your Google account to see your half-marathon tracker.</p>
        <div class="stack stack--sm">
          <button type="button" class="btn btn--secondary btn--lg btn--block" :class="{ 'is-loading': busy }" :disabled="busy" @click="signIn()">
            <svg class="icon icon--brand" viewBox="0 0 48 48" aria-hidden="true">
              <path fill="#EA4335" d="M24 9.5c3.54 0 6.71 1.22 9.21 3.6l6.85-6.85C35.9 2.38 30.47 0 24 0 14.62 0 6.51 5.38 2.56 13.22l7.98 6.19C12.43 13.72 17.74 9.5 24 9.5z" />
              <path fill="#4285F4" d="M46.98 24.55c0-1.57-.15-3.09-.38-4.55H24v9.02h12.94c-.58 2.96-2.26 5.48-4.78 7.18l7.73 6c4.51-4.18 7.09-10.36 7.09-17.65z" />
              <path fill="#FBBC05" d="M10.53 28.59c-.48-1.45-.76-2.99-.76-4.59s.27-3.14.76-4.59l-7.98-6.19C.92 16.46 0 20.12 0 24c0 3.88.92 7.54 2.56 10.78l7.97-6.19z" />
              <path fill="#34A853" d="M24 48c6.48 0 11.93-2.13 15.89-5.81l-7.73-6c-2.15 1.45-4.92 2.3-8.16 2.3-6.26 0-11.57-4.22-13.47-9.91l-7.98 6.19C6.51 42.62 14.62 48 24 48z" />
            </svg>
            Sign in with Google
          </button>
          <div v-if="store.authError" class="banner banner--danger" role="alert">
            <span class="banner__icon"><svg class="icon" aria-hidden="true"><use href="#i-alert" /></svg></span>
            <div class="banner__body"><div class="banner__text text-left">{{ store.authError }}</div></div>
          </div>
        </div>

        <template v-if="store.backend === 'local'">
          <div class="divider divider--text">Dev only (local mode)</div>
          <div class="stack stack--sm">
            <button v-for="p in ['a', 'b']" :key="p" type="button" class="btn btn--secondary btn--block" :disabled="busy" @click="signIn(p)">
              <span class="dot" :class="`dot--${p}`"></span>
              Sign in as {{ PEOPLE[p].name }}
            </button>
          </div>
        </template>
      </template>
    </div>
  </div>
</template>
