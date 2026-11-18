// Shared behaviour of modal sheets (settings, notifications): body scroll lock, Esc to close,
// Tab focus trap, focus the first control on open and restore the previous focus on close.
import { watch, nextTick, onBeforeUnmount } from 'vue';

const FOCUSABLE = 'a[href], button:not([disabled]), input:not([disabled]), select:not([disabled]), textarea:not([disabled]), [tabindex]:not([tabindex="-1"])';

// isOpen: () => boolean, panel: ref to the .sheet__panel element, close: () => void
export function useSheet(isOpen, panel, close) {
  let opener = null;
  let locked = false;

  const lock = on => {
    if (typeof document === 'undefined' || locked === on) return;
    locked = on;
    document.body.classList.toggle('is-scroll-locked', on);
  };

  const onKey = e => {
    if (e.key === 'Escape') { e.preventDefault(); close(); return; }
    if (e.key !== 'Tab' || !panel.value) return;
    const items = [...panel.value.querySelectorAll(FOCUSABLE)].filter(el => el.offsetParent !== null || el === document.activeElement);
    if (!items.length) return;
    const first = items[0], last = items[items.length - 1];
    if (e.shiftKey && document.activeElement === first) { e.preventDefault(); last.focus(); }
    else if (!e.shiftKey && document.activeElement === last) { e.preventDefault(); first.focus(); }
  };

  watch(isOpen, async open => {
    if (typeof document === 'undefined') return;
    if (open) {
      opener = document.activeElement;
      lock(true);
      document.addEventListener('keydown', onKey);
      await nextTick();
      const target = panel.value && (panel.value.querySelector('[data-autofocus]') || panel.value.querySelector(FOCUSABLE));
      if (target) target.focus({ preventScroll: true });
    } else {
      lock(false);
      document.removeEventListener('keydown', onKey);
      if (opener && opener.focus) opener.focus({ preventScroll: true });
      opener = null;
    }
  }, { immediate: true });

  onBeforeUnmount(() => {
    lock(false);
    if (typeof document !== 'undefined') document.removeEventListener('keydown', onKey);
  });
}
