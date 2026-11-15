/**
 * Shell UI: the faint control cluster, the title card and keyboard shortcuts.
 * This module only calls the callbacks it is given; it implements no actions.
 */

const CONTROLS_HIDE_MS = 3000;
const TITLE_REMOVE_FALLBACK_MS = 3200;

/**
 * @param {{
 *   onMute?: () => void,
 *   onFullscreen?: () => void,
 *   onSave?: () => void,
 *   onNextSeason?: () => void,
 *   onClear?: () => void
 * }} [callbacks]
 * @returns {{ setMuted: (muted: boolean) => void, poke: () => void, dismissTitle: () => void }}
 */
export function createUI({ onMute, onFullscreen, onSave, onNextSeason, onClear } = {}) {
  const callbacks = { onMute, onFullscreen, onSave, onNextSeason, onClear };

  const controls = document.getElementById('controls');
  const title = document.getElementById('title');
  const muteBtn = document.getElementById('btn-mute');
  const seasonBtn = document.getElementById('btn-season');
  const saveBtn = document.getElementById('btn-save');
  const fullscreenBtn = document.getElementById('btn-fullscreen');

  let hideTimer = 0;
  let hovering = false;
  let titleDismissed = false;

  // Buttons: stop pointer events from reaching the canvas / window listeners.
  const bindings = [
    [muteBtn, () => callbacks.onMute?.()],
    [seasonBtn, () => callbacks.onNextSeason?.()],
    [saveBtn, () => callbacks.onSave?.()],
    [fullscreenBtn, () => callbacks.onFullscreen?.()],
  ];
  for (const [btn, action] of bindings) {
    if (!btn) continue;
    btn.addEventListener('pointerdown', (e) => e.stopPropagation());
    btn.addEventListener('click', (e) => {
      e.stopPropagation();
      action();
    });
  }

  // Keyboard shortcuts.
  window.addEventListener('keydown', (e) => {
    if (e.key === ' ' || e.key === 'Spacebar') {
      e.preventDefault();
      if (e.repeat || e.metaKey || e.ctrlKey || e.altKey) return;
      callbacks.onNextSeason?.();
      return;
    }
    if (e.metaKey || e.ctrlKey || e.altKey || e.repeat) return;
    const key = e.key.length === 1 ? e.key.toLowerCase() : e.key;
    switch (key) {
      case 'm':
        callbacks.onMute?.();
        break;
      case 'f':
        callbacks.onFullscreen?.();
        break;
      case 's':
        callbacks.onSave?.();
        break;
      case 'c':
        callbacks.onClear?.();
        break;
      default:
        break;
    }
  });

  // Controls stay visible while the pointer is over them.
  if (controls) {
    controls.addEventListener('pointerenter', () => {
      hovering = true;
      poke();
    });
    controls.addEventListener('pointerleave', () => {
      hovering = false;
      scheduleHide();
    });
  }

  function scheduleHide() {
    clearTimeout(hideTimer);
    if (hovering) return;
    hideTimer = setTimeout(() => {
      controls?.classList.remove('visible');
    }, CONTROLS_HIDE_MS);
  }

  /** Show the faint controls briefly. Called on any activity. */
  function poke() {
    if (!controls) return;
    controls.classList.add('visible');
    scheduleHide();
  }

  /** Fade the title card out, once. */
  function dismissTitle() {
    if (titleDismissed || !title) return;
    titleDismissed = true;
    title.classList.add('gone');

    let removed = false;
    const remove = () => {
      if (removed) return;
      removed = true;
      title.remove();
    };
    title.addEventListener('animationend', (e) => {
      if (e.target === title && e.animationName === 'title-out') remove();
    });
    // Fallback in case animations are disabled (reduced motion).
    setTimeout(remove, TITLE_REMOVE_FALLBACK_MS);
  }

  /** Reflect the audio mute state on the mute button. */
  function setMuted(muted) {
    const on = !!muted;
    if (!muteBtn) return;
    muteBtn.classList.toggle('muted', on);
    muteBtn.setAttribute('aria-pressed', String(on));
    const label = on ? 'Unmute sound' : 'Mute sound';
    muteBtn.setAttribute('aria-label', label);
    muteBtn.setAttribute('title', label);
  }

  setMuted(false);

  return { setMuted, poke, dismissTitle };
}
