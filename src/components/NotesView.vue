<script setup>
// NotesView: the message board (text + photo). Props: none. Emits: none. Lazy-loaded by App.vue.
// Reads store.notes (newest first); postNote({text,imageDataUrl}) throws an Error with a user-facing message;
// deleteNote(key). The sender is store.me (identity comes from the Google account). Photos go through compressImage().
import { ref, computed, onBeforeUnmount } from 'vue';
import { store, postNote, deleteNote } from '../store.js';
import { compressImage } from '../utils/image.js';
import { relativeTime } from '../viewmodels.js';

const text = ref('');
const image = ref(null);   // data URL of the compressed photo
const busy = ref(false);   // posting
const imgBusy = ref(false); // compressing
const error = ref('');
const confirming = ref(null); // key of the note whose delete awaits confirmation
const fileInput = ref(null);
let confirmTimer = null;

const canPost = computed(() => !busy.value && !imgBusy.value && (text.value.trim() || image.value));
const sender = computed(() => store.me);

async function pickPhoto(ev) {
  const file = ev.target.files && ev.target.files[0];
  ev.target.value = '';
  if (!file) return;
  error.value = '';
  imgBusy.value = true;
  try { image.value = await compressImage(file); } catch (e) { error.value = (e && e.message) || "Couldn't use that photo."; } finally { imgBusy.value = false; }
}

async function send() {
  if (!canPost.value) return;
  error.value = '';
  busy.value = true;
  try {
    await postNote({ text: text.value, imageDataUrl: image.value });
    text.value = '';
    image.value = null;
  } catch (e) {
    error.value = e.message || "Couldn't send.";
  } finally {
    busy.value = false;
  }
}

// Two-step delete: first tap arms the button for 4 seconds, second tap deletes.
async function remove(key) {
  clearTimeout(confirmTimer);
  if (confirming.value !== key) {
    confirming.value = key;
    confirmTimer = setTimeout(() => { confirming.value = null; }, 4000);
    return;
  }
  confirming.value = null;
  error.value = '';
  try { await deleteNote(key); } catch (e) { error.value = "Couldn't delete the note."; }
}
onBeforeUnmount(() => clearTimeout(confirmTimer));

const who = n => (n.sender === 'a' || n.sender === 'b' ? store.names[n.sender] : n.name || 'Someone');
</script>

<template>
  <section class="stack" aria-label="Notes">
    <form class="card stack stack--md" @submit.prevent="send">
      <div class="field">
        <label class="field__label" for="note-text">Leave a note for {{ store.names[store.me === 'a' ? 'b' : 'a'] }}</label>
        <textarea id="note-text" v-model="text" class="textarea" maxlength="1000" rows="3" placeholder="Say something…"></textarea>
        <p class="field__hint text-xs text-faint">Posting as <span class="dot" :class="sender ? `dot--${sender}` : ''"></span> {{ sender ? store.names[sender] : '' }} · {{ text.length }}/1000</p>
      </div>

      <div v-if="image" class="upload__preview">
        <img :src="image" alt="Photo to be posted">
        <button type="button" class="upload__remove btn btn--ghost btn--icon btn--sm" aria-label="Remove photo" @click="image = null"><svg class="icon icon--sm" aria-hidden="true"><use href="#i-x" /></svg></button>
      </div>
      <label v-else class="upload" :aria-busy="imgBusy">
        <input ref="fileInput" class="sr-only" type="file" accept="image/*" :disabled="imgBusy" @change="pickPhoto">
        <svg class="icon" aria-hidden="true"><use href="#i-camera" /></svg>
        {{ imgBusy ? 'Preparing photo…' : 'Add photo' }}
      </label>

      <div v-if="error" class="banner banner--danger" role="alert">
        <span class="banner__icon"><svg class="icon" aria-hidden="true"><use href="#i-alert" /></svg></span>
        <div class="banner__body"><div class="banner__text">{{ error }}</div></div>
      </div>

      <button type="submit" class="btn btn--primary btn--block" :class="{ 'is-loading': busy }" :disabled="!canPost">{{ busy ? 'Posting…' : 'Post note' }}</button>
    </form>

    <div v-if="!store.notes.length" class="card">
      <div class="empty-state">
        <div class="empty-state__icon" aria-hidden="true">💬</div>
        <h3 class="empty-state__title">No notes yet</h3>
        <p class="empty-state__text">Leave the first note: a plan, a joke, a photo from the trail.</p>
      </div>
    </div>

    <div v-else class="stack stack--sm" role="list" aria-label="Notes, newest first">
      <article v-for="n in store.notes" :key="n.key" class="message" :class="n.sender === 'a' || n.sender === 'b' ? `message--${n.sender}` : ''" role="listitem">
        <div class="message__head">
          <span class="dot" :class="n.sender === 'a' || n.sender === 'b' ? `dot--${n.sender}` : ''"></span>
          <span class="message__name">{{ who(n) }}</span>
          <span class="message__time">{{ relativeTime(n.ts) }}</span>
          <button v-if="n.sender === store.me" type="button" class="btn btn--sm" :class="confirming === n.key ? 'btn--danger' : 'btn--danger-ghost btn--icon'" :aria-label="confirming === n.key ? 'Confirm delete note' : 'Delete note'" @click="remove(n.key)">
            <template v-if="confirming === n.key">Delete?</template>
            <svg v-else class="icon icon--sm" aria-hidden="true"><use href="#i-trash" /></svg>
          </button>
        </div>
        <p v-if="n.text" class="message__text">{{ n.text }}</p>
        <img v-if="n.image" class="message__img" :src="n.image" alt="Photo shared in a note" loading="lazy">
      </article>
    </div>
  </section>
</template>
