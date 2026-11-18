// One-shot prefill for the "Log activity" sheet (e.g. the "Log this run" button of the Next-up card).
// A module-level ref instead of a prop or a store field: the opener sets it right before opening the sheet,
// the sheet takes it (and clears it) when it opens. Opening the sheet any other way finds it empty.
import { ref } from 'vue';

// { sport?: string, runType?: string, km?: number|string, title?: string, note?: string, date?: 'YYYY-MM-DD' } | null
export const logPrefill = ref(null);

export function setLogPrefill(prefill) {
  logPrefill.value = prefill ? { ...prefill, km: prefill.km == null ? '' : String(prefill.km) } : null;
}

// Returns the pending prefill and clears it.
export function takeLogPrefill() {
  const p = logPrefill.value;
  logPrefill.value = null;
  return p;
}
