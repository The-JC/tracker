<script setup>
// LogActivitySheet: bottom sheet to log an activity, or (prop `entry` set) to edit one of your own entries.
// Props: open (boolean), entry (ActivityEntry|null: edit mode, prefilled, no draft). Emits: 'close' (also after a successful save).
// Edit mode calls updateActivity(entry.id, {...fields, photoDataUrl? | removePhoto?}) instead of addActivity.
// Calls addActivity({sport, runType?, title?, date, km?, durationMin?, note?, photoDataUrl?}) which throws an Error with a
// user-facing message on invalid input. Fields are validated up front with validateActivityInput so errors sit next to
// the field; whatever addActivity still throws (offline, permissions...) is shown in a banner.
import { ref, computed, watch, nextTick, onBeforeUnmount } from 'vue';
import { store, today, addActivity, updateActivity, loadPhoto, effectiveStartDate } from '../store.js';
import {
  validateActivityInput, defaultTitle, pointsFor, paceMinPerKm, formatPace, formatKm,
  weekForDate, effectiveStartDate as calcStartDate
} from '../scoring.js';
import { SPORTS, RUN_TYPES, SPORT_BY_KEY, PLAN } from '../plan.js';
import { compressImage } from '../utils/image.js';
import { prepareEdit, formFromEntry, changeSport } from '../utils/entryPatch.js';
import { takeLogPrefill } from '../logPrefill.js';

const props = defineProps({ open: { type: Boolean, default: false }, entry: { type: Object, default: null } });
const emit = defineEmits(['close']);

const blank = sport => ({ sport, runType: 'easy', date: today.value, km: '', durationMin: '', title: '', note: '' });
const form = ref(blank('run'));
const photo = ref(null);        // compressed data URL
const photoBusy = ref(false);
const photoError = ref('');
const submitted = ref(false);   // show field errors only after the first attempt
const saveError = ref('');
const busy = ref(false);

// Edit mode: the entry being edited, its current photo (loaded lazily) and whether the user removed it.
const isEdit = computed(() => !!props.entry);
const existingPhoto = ref(null);
const photoLoading = ref(false);
const photoRemoved = ref(false);
let editedWasOpen = false;     // an edit session replaced the draft: the next "create" opening starts blank

const panel = ref(null);
const sport = computed(() => SPORT_BY_KEY[form.value.sport]);
const hasKm = computed(() => form.value.sport === 'run' || form.value.sport === 'hike');
const needsKm = computed(() => sport.value.requires === 'km');
const placeholderTitle = computed(() => defaultTitle(form.value.sport));

/* ---------- validation + live preview ---------- */

// Same rules for both modes; edit mode validates through prepareEdit (validateActivityInput + future date, undated imports may stay undated).
const checked = computed(() => (isEdit.value
  ? prepareEdit(props.entry, form.value, { today: today.value })
  : validateActivityInput(form.value)));
const preview = computed(() => {
  if (!checked.value.ok) return { points: null, pace: null }; // incomplete input: show dashes
  const v = isEdit.value ? checked.value.next : checked.value.value;
  return { points: pointsFor(v), pace: paceMinPerKm(v) };
});

// Maps the single message of validateActivityInput (plus the future-date rule) to the field it belongs to.
const errors = computed(() => {
  if (!submitted.value) return {};
  const out = {};
  if (form.value.date > today.value) out.date = "That date is in the future. Pick today or earlier.";
  if (!checked.value.ok) {
    const m = checked.value.error;
    if (/date/i.test(m)) out.date ||= m;
    else if (/uration|minutes/i.test(m)) out.durationMin = m;
    else if (/km|distance/i.test(m)) out.km = m;
    else out.general = m;
  }
  return out;
});

/* ---------- plan week chip ---------- */

const weekInfo = computed(() => {
  const iso = form.value.date;
  // Undated imported entry: it keeps counting for its explicit plan week.
  if (isEdit.value && !iso && props.entry.week >= 1) return { n: props.entry.week, inPlan: props.entry.week <= PLAN.length };
  if (!/^\d{4}-\d{2}-\d{2}$/.test(iso)) return null;
  // A first dated run moves the effective plan start (see effectiveStartDate), so include it in the lookup
  // (in edit mode without the entry itself, whose old date no longer counts).
  const others = isEdit.value ? store.log.filter(e => e.id !== props.entry.id) : store.log;
  const start = form.value.sport === 'run'
    ? calcStartDate(store.settings.startDate, [...others, { sport: 'run', date: iso }], today.value)
    : effectiveStartDate.value;
  const n = weekForDate(start, iso);
  return { n, inPlan: n >= 1 && n <= PLAN.length };
});

/* ---------- open / close: scroll lock, focus, Escape ---------- */

let returnFocus = null;
const lock = on => document.body.classList.toggle('is-scroll-locked', on);

function close() { if (!busy.value) emit('close'); }

function onKeydown(e) {
  if (e.key === 'Escape') { e.preventDefault(); close(); return; }
  if (e.key !== 'Tab' || !panel.value) return;
  // Keep Tab inside the dialog.
  const items = [...panel.value.querySelectorAll('button:not(:disabled), input:not(:disabled), textarea:not(:disabled), select:not(:disabled), [href]')]
    .filter(el => el.offsetParent !== null || el === document.activeElement);
  if (!items.length) return;
  const first = items[0], last = items[items.length - 1];
  if (e.shiftKey && (document.activeElement === first || !panel.value.contains(document.activeElement))) { e.preventDefault(); last.focus(); }
  else if (!e.shiftKey && document.activeElement === last) { e.preventDefault(); first.focus(); }
}

// Edit mode: prefill from the entry (no draft); load its photo for the preview.
function startEdit() {
  const entry = props.entry;
  editedWasOpen = true;
  form.value = formFromEntry(entry);
  photo.value = null;
  photoError.value = '';
  photoRemoved.value = false;
  existingPhoto.value = null;
  photoLoading.value = !!entry.hasPhoto;
  if (entry.hasPhoto) {
    loadPhoto(entry.id).then(url => { if (props.entry && props.entry.id === entry.id) existingPhoto.value = url; })
      .finally(() => { photoLoading.value = false; });
  }
}

function setSport(key) {
  form.value = isEdit.value ? changeSport(form.value, key) : { ...form.value, sport: key };
}

watch(() => props.open, async o => {
  if (o) {
    returnFocus = document.activeElement;
    submitted.value = false;
    saveError.value = '';
    if (props.entry) startEdit();
    else if (editedWasOpen) { editedWasOpen = false; form.value = blank('run'); photo.value = null; photoError.value = ''; }
    const prefill = takeLogPrefill(); // set by e.g. the Next-up card's "Log this run"
    if (prefill && !props.entry) { form.value = { ...blank(prefill.sport || 'run'), ...prefill }; photo.value = null; photoError.value = ''; }
    if (form.value.date > today.value) form.value.date = today.value; // stale draft after midnight/timezone change
    lock(true);
    document.addEventListener('keydown', onKeydown);
    await nextTick();
    const first = panel.value && (panel.value.querySelector('.chip[aria-pressed="true"]') || panel.value.querySelector('input, button'));
    if (first) first.focus({ preventScroll: true });
  } else {
    lock(false);
    document.removeEventListener('keydown', onKeydown);
    if (returnFocus && returnFocus.isConnected && returnFocus.focus) returnFocus.focus({ preventScroll: true });
    returnFocus = null;
  }
}, { immediate: true });

onBeforeUnmount(() => {
  document.removeEventListener('keydown', onKeydown);
  if (props.open) lock(false);
});

/* ---------- photo ---------- */

async function onPhoto(e) {
  const file = e.target.files && e.target.files[0];
  e.target.value = ''; // allow choosing the same file again after removing it
  if (!file) return;
  photoError.value = '';
  photoBusy.value = true;
  try {
    photo.value = await compressImage(file);
  } catch (err) {
    photoError.value = err && err.message ? err.message : "Couldn't read that photo.";
  } finally {
    photoBusy.value = false;
  }
}

const keptPhoto = computed(() => isEdit.value && props.entry.hasPhoto && !photoRemoved.value && !photo.value);
const shownPhoto = computed(() => photo.value || (keptPhoto.value ? existingPhoto.value : null));
function removePhoto() { photo.value = null; photoRemoved.value = true; }

/* ---------- save ---------- */

function focusFirstError() {
  nextTick(() => {
    const el = panel.value && panel.value.querySelector('[aria-invalid="true"]');
    if (el) { el.focus(); el.scrollIntoView({ block: 'center' }); }
  });
}

async function save() {
  if (busy.value || photoBusy.value) return;
  submitted.value = true;
  saveError.value = '';
  if (Object.keys(errors.value).length) {
    if (errors.value.general) saveError.value = errors.value.general;
    focusFirstError();
    return;
  }
  busy.value = true;
  try {
    if (isEdit.value) {
      await updateActivity(props.entry.id, {
        ...form.value, photoDataUrl: photo.value || undefined, removePhoto: photoRemoved.value && !photo.value ? true : undefined
      });
      editedWasOpen = true;
    } else {
      await addActivity({ ...form.value, photoDataUrl: photo.value || undefined });
      form.value = blank(form.value.sport); // keep the last sport
    }
    photo.value = null;
    photoError.value = '';
    submitted.value = false;
    busy.value = false;
    emit('close');
  } catch (e) {
    saveError.value = e && e.message ? e.message : "Couldn't save the activity. Check your connection and try again.";
    busy.value = false;
  }
}
</script>

<template>
  <Transition name="sheet">
    <div v-if="open" class="sheet">
      <div class="sheet__backdrop" @click="close"></div>
      <div ref="panel" class="sheet__panel" role="dialog" aria-modal="true" aria-labelledby="log-sheet-title">
        <div class="sheet__handle"></div>
        <header class="sheet__header">
          <h2 id="log-sheet-title" class="sheet__title">{{ isEdit ? 'Edit activity' : 'Log activity' }}</h2>
          <button type="button" class="btn btn--ghost btn--icon btn--round" aria-label="Close" @click="close">
            <svg class="icon" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" aria-hidden="true"><path d="M6 6l12 12M18 6L6 18" /></svg>
          </button>
        </header>

        <form id="log-activity-form" class="sheet__body stack" novalidate @submit.prevent="save">
          <div class="field">
            <span id="log-sport-label" class="field__label">Sport</span>
            <div class="chip-row chip-row--wrap" role="group" aria-labelledby="log-sport-label">
              <button v-for="s in SPORTS" :key="s.key" type="button" class="chip" :class="{ 'is-active': form.sport === s.key }" :aria-pressed="form.sport === s.key" @click="setSport(s.key)">
                <span aria-hidden="true">{{ s.emoji }}</span> {{ s.label }}
              </button>
            </div>
          </div>

          <div v-if="form.sport === 'run'" class="field">
            <span id="log-type-label" class="field__label">Type of run</span>
            <div class="chip-row chip-row--wrap" role="group" aria-labelledby="log-type-label">
              <button v-for="t in RUN_TYPES" :key="t.key" type="button" class="chip" :class="{ 'is-active': form.runType === t.key }" :aria-pressed="form.runType === t.key" @click="form.runType = t.key">
                {{ t.name }} <span class="text-xs num">×{{ t.mult }}</span>
              </button>
            </div>
          </div>

          <div class="field">
            <label class="field__label" for="log-title">Title</label>
            <input id="log-title" v-model="form.title" class="input" type="text" maxlength="80" :placeholder="placeholderTitle" autocomplete="off">
          </div>

          <div class="field" :class="{ 'field--error': errors.date }">
            <label class="field__label" for="log-date">Date</label>
            <input id="log-date" v-model="form.date" class="input" type="date" :max="today" :required="!(isEdit && !entry.date)" :aria-invalid="errors.date ? 'true' : null" :aria-describedby="errors.date ? 'log-date-error' : null">
            <p v-if="errors.date" id="log-date-error" class="field__error">{{ errors.date }}</p>
            <p v-else-if="isEdit && !entry.date" class="field__hint">Imported entry without a date. Pick the real date, or leave it empty.</p>
          </div>

          <div v-if="hasKm" class="field" :class="{ 'field--error': errors.km }">
            <label class="field__label" for="log-km">Distance{{ needsKm ? '' : ' (optional)' }}</label>
            <div class="input-group">
              <input id="log-km" v-model="form.km" class="input" type="text" inputmode="decimal" autocomplete="off" placeholder="0.0" :aria-invalid="errors.km ? 'true' : null" :aria-describedby="errors.km ? 'log-km-error' : null">
              <span class="input-group__addon">km</span>
            </div>
            <p v-if="errors.km" id="log-km-error" class="field__error">{{ errors.km }}</p>
          </div>

          <div class="field" :class="{ 'field--error': errors.durationMin }">
            <label class="field__label" for="log-duration">{{ needsKm ? 'Time (optional)' : 'Duration' }}</label>
            <div class="input-group">
              <input id="log-duration" v-model="form.durationMin" class="input" type="text" inputmode="decimal" autocomplete="off" placeholder="0" :aria-invalid="errors.durationMin ? 'true' : null" :aria-describedby="errors.durationMin ? 'log-duration-error' : 'log-duration-hint'">
              <span class="input-group__addon">min</span>
            </div>
            <p v-if="errors.durationMin" id="log-duration-error" class="field__error">{{ errors.durationMin }}</p>
            <p v-else-if="hasKm" id="log-duration-hint" class="field__hint">Total minutes. Adds your pace.</p>
          </div>

          <div class="stat-row stat-row--divided card card--inset" aria-live="polite" aria-label="Preview">
            <div class="stat stat--sm stat--center">
              <span class="stat__value num">{{ preview.points === null ? '–' : formatKm(preview.points) }}</span>
              <span class="stat__label">Points</span>
            </div>
            <div v-if="hasKm" class="stat stat--sm stat--center">
              <span class="stat__value num">{{ preview.pace === null ? '–' : formatPace(preview.pace) }}<span v-if="preview.pace !== null" class="stat__unit">/km</span></span>
              <span class="stat__label">Pace</span>
            </div>
          </div>

          <div v-if="weekInfo" class="row row--wrap">
            <span v-if="weekInfo.inPlan" class="chip chip--info">{{ form.sport === 'run' ? 'Counts for' : 'Logged in' }} Week {{ weekInfo.n }}</span>
            <span v-else class="chip chip--info">Outside the plan{{ form.sport === 'run' ? ': won\'t count for a week' : '' }}</span>
          </div>

          <div class="field">
            <label class="field__label" for="log-note">Note (optional)</label>
            <textarea id="log-note" v-model="form.note" class="textarea" maxlength="500" rows="3" placeholder="How did it feel?"></textarea>
          </div>

          <div class="field" :class="{ 'field--error': photoError }">
            <span class="field__label">Photo (optional)</span>
            <div v-if="shownPhoto" class="upload__preview">
              <img :src="shownPhoto" alt="Selected photo preview">
              <button type="button" class="upload__remove btn btn--sm btn--secondary" @click="removePhoto">Remove</button>
            </div>
            <div v-else-if="keptPhoto && photoLoading" class="skeleton skeleton--media" role="status" aria-label="Loading photo"></div>
            <p v-else-if="keptPhoto" class="field__hint">
              The current photo couldn't be loaded. It stays unless you replace or remove it.
              <button type="button" class="btn btn--ghost btn--sm" @click="removePhoto">Remove</button>
            </p>
            <label v-if="!shownPhoto && !(keptPhoto && photoLoading) || (isEdit && shownPhoto)" class="upload">
              <input class="sr-only" type="file" accept="image/*" :disabled="photoBusy" @change="onPhoto">
              <svg class="icon" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M4 8h3l2-3h6l2 3h3v11H4z" /><circle cx="12" cy="13" r="3.5" /></svg>
              {{ photoBusy ? 'Processing photo…' : shownPhoto || keptPhoto ? 'Replace photo' : 'Add a photo' }}
            </label>
            <p v-if="photoError" class="field__error" role="alert">{{ photoError }}</p>
          </div>

          <div v-if="saveError" class="banner banner--danger" role="alert">
            <span class="banner__icon" aria-hidden="true">!</span>
            <div class="banner__body"><div class="banner__text">{{ saveError }}</div></div>
          </div>
        </form>

        <footer class="sheet__footer">
          <button v-if="isEdit" type="button" class="btn btn--secondary" :disabled="busy" @click="close">Cancel</button>
          <button type="submit" form="log-activity-form" class="btn btn--primary btn--block" :class="{ 'is-loading': busy }" :aria-busy="busy ? 'true' : null" :disabled="busy || photoBusy">{{ isEdit ? 'Save changes' : 'Save activity' }}</button>
        </footer>
      </div>
    </div>
  </Transition>
</template>
