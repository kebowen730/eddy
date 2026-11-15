/**
 * Shell UI: the faint control cluster, the title card and keyboard shortcuts.
 * This module only calls the callbacks it is given; it implements no actions.
 */

const CONTROLS_HIDE_MS = 3000;
const TITLE_REMOVE_FALLBACK_MS = 3200;
const TOAST_MS = 3500;
const GLOW_FADE_MS = 1200;
const MAX_GLOWS = 8;

const STATUS_TEXT = {
  connecting: 'opening the easel…',
  reconnecting: 'lost the thread. reconnecting…',
  full: 'this easel is full',
};

/**
 * @param {{
 *   onMute?: () => void,
 *   onFullscreen?: () => void,
 *   onSave?: () => void,
 *   onNextSeason?: () => void,
 *   onClear?: () => void,
 *   onShare?: () => string,   // button / `e`; returns the easel link synchronously (creating
 *                             // the easel if needed) so it can be copied inside the gesture
 *   onLeave?: () => void,     // "leave" in the easel panel
 *   onScour?: () => void      // Shift+C
 * }} [callbacks]
 * @returns {{
 *   setMuted: (muted: boolean) => void,
 *   poke: () => void,
 *   dismissTitle: () => void,
 *   setEasel: (s: { status: string, link?: string|null, count?: number }) => void,
 *   toast: (text: string) => void,
 *   setHint: (text: string) => void,
 *   remoteTouch: (peerId: number, x: number, y: number) => void,
 *   dropPeer: (peerId: number) => void
 * }}
 *   setEasel is cheap and idempotent and never opens the panel; status is one of
 *   'off' | 'connecting' | 'live' | 'reconnecting' | 'full', count includes you.
 *   remoteTouch takes normalised coordinates with y pointing up.
 */
export function createUI({
  onMute,
  onFullscreen,
  onSave,
  onNextSeason,
  onClear,
  onShare,
  onLeave,
  onScour,
} = {}) {
  const callbacks = { onMute, onFullscreen, onSave, onNextSeason, onClear, onShare, onLeave, onScour };

  const controls = document.getElementById('controls');
  const title = document.getElementById('title');
  const muteBtn = document.getElementById('btn-mute');
  const seasonBtn = document.getElementById('btn-season');
  const saveBtn = document.getElementById('btn-save');
  const fullscreenBtn = document.getElementById('btn-fullscreen');
  const shareBtn = document.getElementById('btn-share');
  const shareNum = shareBtn?.querySelector('.num') ?? null;
  const panel = document.getElementById('easel-panel');
  const statusEl = document.getElementById('easel-status');
  const linkEl = document.getElementById('easel-link');
  const copyBtn = document.getElementById('easel-copy');
  const nativeShareBtn = document.getElementById('easel-share');
  const leaveBtn = document.getElementById('easel-leave');
  const toastEl = document.getElementById('toast');
  const presence = document.getElementById('presence');
  const stage = document.getElementById('stage');

  let hideTimer = 0;
  let hovering = false;
  let titleDismissed = false;
  let panelOpen = false;
  let toastTimer = 0;
  const easel = { status: 'off', link: '', count: 1 };

  // Buttons: stop pointer events from reaching the canvas / window listeners.
  const bindings = [
    [muteBtn, () => callbacks.onMute?.()],
    [seasonBtn, () => callbacks.onNextSeason?.()],
    [saveBtn, () => callbacks.onSave?.()],
    [fullscreenBtn, () => callbacks.onFullscreen?.()],
    [shareBtn, () => share()],
  ];
  for (const [btn, action] of bindings) {
    if (!btn) continue;
    btn.addEventListener('pointerdown', (e) => e.stopPropagation());
    btn.addEventListener('click', (e) => {
      e.stopPropagation();
      action();
    });
  }

  // Easel panel: nothing inside it may reach the canvas (a drag in here must not stir the ink).
  if (panel) {
    for (const type of ['pointerdown', 'pointermove', 'pointerup', 'click']) {
      panel.addEventListener(type, (e) => e.stopPropagation());
    }
  }
  copyBtn?.addEventListener('click', () => {
    if (easel.link) copyLink(easel.link);
  });
  leaveBtn?.addEventListener('click', () => {
    callbacks.onLeave?.();
    closePanel();
  });
  if (nativeShareBtn) {
    nativeShareBtn.hidden = typeof navigator.share !== 'function';
    nativeShareBtn.addEventListener('click', () => {
      if (!easel.link || typeof navigator.share !== 'function') return;
      try {
        // Cancelling the sheet rejects; that is not an error worth showing.
        Promise.resolve(
          navigator.share({ title: 'Eddy', text: 'stir this pool with me', url: easel.link }),
        ).catch(() => {});
      } catch {
        /* ignore */
      }
    });
  }
  // Selecting the link on click/tap is the manual-copy fallback.
  linkEl?.addEventListener('focus', () => linkEl.select());
  linkEl?.addEventListener('click', () => linkEl.select());
  // Touching the pool closes the panel; the event still reaches the canvas.
  stage?.addEventListener('pointerdown', () => closePanel());

  // Keyboard shortcuts.
  window.addEventListener('keydown', (e) => {
    // Typing in the link field (or any input) must not trigger shortcuts.
    const t = e.target;
    if (t && (t.tagName === 'INPUT' || t.tagName === 'TEXTAREA' || t.isContentEditable)) {
      if (e.key === 'Escape') closePanel();
      return;
    }
    if (e.key === 'Escape') {
      closePanel();
      return;
    }
    if (e.key === ' ' || e.key === 'Spacebar') {
      e.preventDefault();
      if (e.repeat || e.metaKey || e.ctrlKey || e.altKey) return;
      callbacks.onNextSeason?.();
      return;
    }
    if (e.metaKey || e.ctrlKey || e.altKey || e.repeat) return;
    // Shift+C scours the floor too; e.key is "C" then, so check before lowercasing.
    if (e.shiftKey && (e.key === 'C' || e.key === 'c')) {
      callbacks.onScour?.();
      return;
    }
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
      case 'e':
        share();
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
    if (hovering || panelOpen) return;
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

  // ---------- Easel: share button, panel, toast ----------

  /** Share button / `e`: toggle the panel; opening it also copies the link, inside the gesture. */
  function share() {
    if (panelOpen) {
      closePanel();
      return;
    }
    const link = callbacks.onShare?.();
    if (typeof link === 'string' && link) easel.link = link;
    // The lead's setEasel may not have landed yet; do not show an empty panel meanwhile.
    if (easel.status === 'off') easel.status = 'connecting';
    renderPanel();
    openPanel();
    if (easel.link) copyLink(easel.link);
  }

  function openPanel() {
    if (!panel) return;
    panelOpen = true;
    panel.hidden = false;
    document.documentElement.classList.add('easel-open');
    poke();
  }

  function closePanel() {
    if (!panelOpen) return;
    panelOpen = false;
    if (panel) panel.hidden = true;
    document.documentElement.classList.remove('easel-open');
    scheduleHide();
  }

  /** Copy now (we are inside a user gesture); if that fails, leave the link selected. */
  function copyLink(link) {
    const done = (ok) => {
      if (ok) {
        toast('link copied');
      } else {
        toast('copy the link below');
        if (linkEl && panelOpen) {
          linkEl.focus();
          linkEl.select();
        }
      }
    };
    let pending = false;
    try {
      if (navigator.clipboard?.writeText) {
        pending = true;
        navigator.clipboard.writeText(link).then(
          () => done(true),
          () => done(legacyCopy()),
        );
      }
    } catch {
      pending = false;
    }
    if (!pending) done(legacyCopy());
  }

  /** Old-school copy from the selected input; also synchronous, so still within the gesture. */
  function legacyCopy() {
    if (!linkEl) return false;
    try {
      linkEl.focus();
      linkEl.select();
      return !!document.execCommand?.('copy');
    } catch {
      return false;
    }
  }

  function renderPanel() {
    const { status, link, count } = easel;
    if (statusEl) {
      let text = STATUS_TEXT[status] ?? '';
      if (status === 'live') {
        text = count >= 2 ? `${count} of you are stirring this pool` : 'only you here. send the link to someone.';
      }
      if (statusEl.textContent !== text) statusEl.textContent = text;
    }
    if (linkEl && linkEl.value !== link) linkEl.value = link;
    // A full easel has nothing to copy or share.
    if (panel) panel.toggleAttribute('data-empty', status === 'full' || !link);
  }

  function renderShareButton() {
    if (!shareBtn) return;
    const active = easel.status === 'live' || easel.status === 'reconnecting';
    shareBtn.classList.toggle('live', active);
    shareBtn.classList.toggle('reconnecting', easel.status === 'reconnecting');
    const label = active ? `Easel shared with ${easel.count}` : 'Share this easel';
    if (shareBtn.getAttribute('aria-label') !== label) {
      shareBtn.setAttribute('aria-label', label);
      shareBtn.setAttribute('title', label);
    }
    if (shareNum) {
      const n = active && easel.count >= 2 ? String(easel.count) : '';
      if (shareNum.textContent !== n) shareNum.textContent = n;
    }
  }

  /** Reflect the easel state. Called often; never opens the panel by itself. */
  function setEasel({ status, link, count } = {}) {
    const st = status ?? 'off';
    const lk = typeof link === 'string' ? link : '';
    const n = Number.isFinite(count) ? Math.max(1, Math.floor(count)) : 1;
    if (st === easel.status && lk === easel.link && n === easel.count) return;
    easel.status = st;
    // A null link keeps the one onShare gave us until the easel really is off.
    easel.link = lk || (st === 'off' ? '' : easel.link);
    easel.count = n;
    renderShareButton();
    if (st === 'off') {
      closePanel();
    } else if (panelOpen) {
      renderPanel();
    }
  }

  /** One quiet line near the bottom; a new toast replaces the current one. */
  function toast(text) {
    if (!toastEl) return;
    clearTimeout(toastTimer);
    toastEl.textContent = String(text ?? '');
    toastEl.classList.add('show');
    toastTimer = setTimeout(() => toastEl.classList.remove('show'), TOAST_MS);
  }

  /** Replace the title card's hint word(s). No-op once the title is gone. */
  function setHint(text) {
    if (titleDismissed) return;
    const hint = title?.querySelector('.hint');
    if (hint) hint.textContent = String(text ?? '');
  }

  // ---------- Remote glows ----------

  const glows = new Map(); // peerId -> { el, last, on }
  const freeGlows = [];
  let glowCount = 0;
  let glowTimer = 0;
  let presenceW = window.innerWidth;
  let presenceH = window.innerHeight;
  window.addEventListener('resize', () => {
    presenceW = window.innerWidth;
    presenceH = window.innerHeight;
  });

  /** Get this peer's glow, reusing a free element or, at the cap, the longest-idle one. */
  function glowFor(peerId) {
    let g = glows.get(peerId);
    if (g) return g;
    let el = freeGlows.pop();
    if (!el && glowCount < MAX_GLOWS) {
      el = document.createElement('div');
      el.className = 'glow';
      presence.appendChild(el);
      glowCount++;
    }
    if (!el) {
      let oldestId = null;
      let oldest = Infinity;
      for (const [id, other] of glows) {
        if (other.last < oldest) {
          oldest = other.last;
          oldestId = id;
        }
      }
      el = glows.get(oldestId).el;
      glows.delete(oldestId);
      el.classList.remove('on');
    }
    g = { el, last: 0, on: false };
    el.style.setProperty('--hue', String(((peerId | 0) * 137) % 360));
    glows.set(peerId, g);
    return g;
  }

  /** Move a peer's soft glow to (x, y), normalised with y up; it fades when they stop. */
  function remoteTouch(peerId, x, y) {
    if (!presence || !Number.isFinite(x) || !Number.isFinite(y)) return;
    const g = glowFor(peerId);
    const px = Math.min(1, Math.max(0, x)) * presenceW;
    const py = (1 - Math.min(1, Math.max(0, y))) * presenceH;
    const el = g.el;
    if (!g.on) {
      // Reappearing: jump to the spot instead of gliding from where it last was.
      el.classList.add('jump');
      el.style.transform = `translate3d(${px}px, ${py}px, 0)`;
      requestAnimationFrame(() => el.classList.remove('jump'));
      el.classList.add('on');
      g.on = true;
    } else {
      el.style.transform = `translate3d(${px}px, ${py}px, 0)`;
    }
    g.last = performance.now();
    if (!glowTimer) glowTimer = setInterval(sweepGlows, 200);
  }

  /** One shared timer fades idle glows (cheaper than a timeout per update). */
  function sweepGlows() {
    const now = performance.now();
    let anyOn = false;
    for (const g of glows.values()) {
      if (!g.on) continue;
      if (now - g.last > GLOW_FADE_MS) {
        g.el.classList.remove('on');
        g.on = false;
      } else {
        anyOn = true;
      }
    }
    if (!anyOn) {
      clearInterval(glowTimer);
      glowTimer = 0;
    }
  }

  /** Forget a peer: its glow element goes back to the pool. */
  function dropPeer(peerId) {
    const g = glows.get(peerId);
    if (!g) return;
    glows.delete(peerId);
    g.el.classList.remove('on');
    freeGlows.push(g.el);
  }

  return { setMuted, poke, dismissTitle, setEasel, toast, setHint, remoteTouch, dropPeer };
}
