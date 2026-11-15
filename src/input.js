/**
 * Pointer gesture layer for Eddy.
 *
 * Turns DOM pointer events on the stage canvas into normalised UV coordinates
 * (x: 0 left -> 1 right, y: 0 bottom -> 1 top) and emits stroke, hold and
 * double-tap gestures. Driven per frame by `input.update(dt)`.
 */

/** Movement (UV) under which a pointer counts as still. */
const HOLD_MOVE = 0.012;
/** Seconds a pointer must stay still before it becomes a hold. */
const HOLD_TIME = 0.35;
/** Drift (UV) from the hold anchor that ends a hold. */
const HOLD_BREAK = 0.03;
/** Max seconds between two pointerdowns that make a double tap. */
const TAP_TIME = 0.32;
/** Max distance (UV) between the two taps of a double tap. */
const TAP_DIST = 0.05;
/** Clamp range for the per-sample dt used in velocity estimates (seconds). */
const DT_MIN = 1 / 240;
const DT_MAX = 1 / 20;
/** Pressure reported for mouse hover (no button down). */
const HOVER_PRESSURE = 0.35;

/**
 * @typedef {Object} PointerRecord
 * @property {number} id
 * @property {string} type            pointerType ('mouse' | 'touch' | 'pen')
 * @property {number} x
 * @property {number} y
 * @property {boolean} down
 * @property {boolean} held
 * @property {number} heldTime         seconds held (0 when not held)
 * @property {number} anchorX
 * @property {number} anchorY
 * @property {number} stillTime        seconds since the anchor was (re)set
 * @property {boolean} noHold          true for the second tap of a double tap
 * @property {number} lastX
 * @property {number} lastY
 * @property {number} lastT            seconds (event.timeStamp based)
 * @property {number} vx
 * @property {number} vy
 */

/**
 * @typedef {Object} InputHandlers
 * @property {(e: {id:number,x:number,y:number,vx:number,vy:number,speed:number,angle:number,pressure:number,hover:boolean}) => void} [onStroke]
 * @property {(e: {id:number,x:number,y:number}) => void} [onHoldStart]
 * @property {(e: {id:number,x:number,y:number,t:number}) => void} [onHold]
 * @property {(e: {id:number,x:number,y:number,t:number}) => void} [onHoldEnd]
 * @property {(e: {x:number,y:number}) => void} [onDoubleTap]
 * @property {() => void} [onFirstGesture]
 * @property {() => void} [onActivity]
 */

/**
 * Create the pointer input layer bound to a canvas.
 *
 * @param {HTMLCanvasElement} canvas
 * @param {InputHandlers} [handlers] all handlers optional
 * @returns {{
 *   update: (dt: number) => void,
 *   pointers: Map<number, PointerRecord>,
 *   readonly primary: {x:number,y:number,down:boolean,held:boolean} | null,
 *   idleTime: number,
 *   dispose: () => void
 * }}
 */
export function createInput(canvas, handlers) {
  const h = handlers || {};
  /** @type {Map<number, PointerRecord>} */
  const pointers = new Map();
  const primaryOut = { x: 0, y: 0, down: false, held: false };
  let hasPrimary = false;
  let primaryId = null;
  let started = false;
  /** @type {{t:number,x:number,y:number} | null} */
  let lastTap = null;

  canvas.style.touchAction = 'none';

  const input = {
    pointers,
    idleTime: 0,
    update,
    dispose,
    get primary() {
      return hasPrimary ? primaryOut : null;
    },
  };

  // ---------------------------------------------------------------- helpers

  /** Convert client coords to UV (y flipped to bottom -> top). */
  function toUV(clientX, clientY) {
    const r = canvas.getBoundingClientRect();
    const w = r.width || 1;
    const hgt = r.height || 1;
    return { x: (clientX - r.left) / w, y: 1 - (clientY - r.top) / hgt };
  }

  /** Event time in seconds. */
  function timeOf(e) {
    const ts = e.timeStamp > 0 ? e.timeStamp : performance.now();
    return ts / 1000;
  }

  function markActivity() {
    input.idleTime = 0;
    h.onActivity?.();
  }

  function firstGesture() {
    if (started) return;
    started = true;
    window.removeEventListener('pointerdown', onWindowPointerDown, true);
    window.removeEventListener('keydown', onWindowKeyDown, true);
    h.onFirstGesture?.();
  }

  function syncPrimary(rec) {
    primaryId = rec.id;
    hasPrimary = true;
    primaryOut.x = rec.x;
    primaryOut.y = rec.y;
    primaryOut.down = rec.down;
    primaryOut.held = rec.held;
  }

  function pressureOf(e, down) {
    if (e.pointerType === 'pen' && e.pressure > 0) return e.pressure;
    return down ? 1 : HOVER_PRESSURE;
  }

  /**
   * Emit one stroke sample, updating the smoothed velocity of the record.
   */
  function emitStroke(rec, x, y, t, pressure, hover) {
    const dt = Math.min(Math.max(t - rec.lastT, DT_MIN), DT_MAX);
    const rvx = (x - rec.lastX) / dt;
    const rvy = (y - rec.lastY) / dt;
    rec.vx = 0.5 * rec.vx + 0.5 * rvx;
    rec.vy = 0.5 * rec.vy + 0.5 * rvy;
    rec.lastX = x;
    rec.lastY = y;
    rec.lastT = t;
    h.onStroke?.({
      id: rec.id,
      x,
      y,
      vx: rec.vx,
      vy: rec.vy,
      speed: Math.hypot(rec.vx, rec.vy),
      angle: Math.atan2(rec.vy, rec.vx),
      pressure,
      hover,
    });
  }

  /** Finish a press (up, cancel, or a lost mouse release). */
  function endPress(rec, x, y, cancelled) {
    if (rec.held) {
      rec.held = false;
      const t = rec.heldTime;
      rec.heldTime = 0;
      h.onHoldEnd?.({ id: rec.id, x, y, t });
    }
    rec.down = false;
    rec.stillTime = 0;
    rec.noHold = false;
    rec.x = x;
    rec.y = y;
    if (rec.type !== 'mouse') {
      // Touch / pen contacts only exist while down.
      pointers.delete(rec.id);
      if (primaryId === rec.id) {
        primaryOut.down = false;
        primaryOut.held = false;
      }
    } else if (primaryId === rec.id) {
      syncPrimary(rec);
    }
    void cancelled;
  }

  // ---------------------------------------------------------------- events

  function onPointerDown(e) {
    firstGesture();
    markActivity();
    const p = toUV(e.clientX, e.clientY);
    const t = timeOf(e);
    try {
      canvas.setPointerCapture(e.pointerId);
    } catch (_) {
      /* capture is best-effort */
    }

    // Double tap detection.
    let isDouble = false;
    if (
      lastTap &&
      t - lastTap.t < TAP_TIME &&
      Math.hypot(p.x - lastTap.x, p.y - lastTap.y) < TAP_DIST
    ) {
      isDouble = true;
      lastTap = null;
      h.onDoubleTap?.({ x: p.x, y: p.y });
    } else {
      lastTap = { t, x: p.x, y: p.y };
    }

    let rec = pointers.get(e.pointerId);
    if (!rec) {
      rec = {
        id: e.pointerId,
        type: e.pointerType || 'mouse',
        x: p.x,
        y: p.y,
        down: false,
        held: false,
        heldTime: 0,
        anchorX: p.x,
        anchorY: p.y,
        stillTime: 0,
        noHold: false,
        lastX: p.x,
        lastY: p.y,
        lastT: t,
        vx: 0,
        vy: 0,
      };
      pointers.set(e.pointerId, rec);
    }
    rec.x = p.x;
    rec.y = p.y;
    rec.down = true;
    rec.held = false;
    rec.heldTime = 0;
    rec.anchorX = p.x;
    rec.anchorY = p.y;
    rec.stillTime = 0;
    rec.noHold = isDouble;
    rec.lastX = p.x;
    rec.lastY = p.y;
    rec.lastT = t;
    syncPrimary(rec);
  }

  function onPointerMove(e) {
    markActivity();
    const isMouse = e.pointerType === 'mouse';
    let rec = pointers.get(e.pointerId);
    if (!rec) {
      if (!isMouse) return;
      // First sighting of a mouse: create a hover-only record.
      const p0 = toUV(e.clientX, e.clientY);
      rec = {
        id: e.pointerId,
        type: 'mouse',
        x: p0.x,
        y: p0.y,
        down: false,
        held: false,
        heldTime: 0,
        anchorX: p0.x,
        anchorY: p0.y,
        stillTime: 0,
        noHold: false,
        lastX: p0.x,
        lastY: p0.y,
        lastT: timeOf(e),
        vx: 0,
        vy: 0,
      };
      pointers.set(e.pointerId, rec);
    }

    // A mouse that lost its button outside the window: treat as released.
    if (rec.down && isMouse && e.buttons === 0) {
      const p1 = toUV(e.clientX, e.clientY);
      endPress(rec, p1.x, p1.y, false);
    }

    const p = toUV(e.clientX, e.clientY);
    const t = timeOf(e);
    const down = rec.down;

    // Mouse hover is emitted at low pressure; touch/pen only while down.
    if (down || isMouse) {
      const coalesced =
        typeof e.getCoalescedEvents === 'function' ? e.getCoalescedEvents() : null;
      const samples = coalesced && coalesced.length ? coalesced : [e];
      for (let i = 0; i < samples.length; i++) {
        const s = samples[i];
        const sp = s === e ? p : toUV(s.clientX, s.clientY);
        const st = s === e ? t : timeOf(s);
        emitStroke(rec, sp.x, sp.y, st, pressureOf(s, rec.down), !rec.down);
      }
    }

    rec.x = p.x;
    rec.y = p.y;

    if (rec.down) {
      const moved = Math.hypot(p.x - rec.anchorX, p.y - rec.anchorY);
      if (rec.held) {
        if (moved > HOLD_BREAK) {
          // Drifted away: end the hold and resume stroking from here.
          rec.held = false;
          const ht = rec.heldTime;
          rec.heldTime = 0;
          rec.anchorX = p.x;
          rec.anchorY = p.y;
          rec.stillTime = 0;
          h.onHoldEnd?.({ id: rec.id, x: p.x, y: p.y, t: ht });
        }
      } else if (moved > HOLD_MOVE) {
        rec.anchorX = p.x;
        rec.anchorY = p.y;
        rec.stillTime = 0;
      }
    }

    syncPrimary(rec);
  }

  function onPointerUp(e) {
    const rec = pointers.get(e.pointerId);
    if (!rec) return;
    const p = toUV(e.clientX, e.clientY);
    endPress(rec, p.x, p.y, false);
  }

  function onPointerCancel(e) {
    const rec = pointers.get(e.pointerId);
    if (!rec) return;
    endPress(rec, rec.x, rec.y, true);
  }

  function onPointerLeave(e) {
    // Mouse keeps its last position for hover; touch/pen contacts that are
    // no longer down are removed.
    const rec = pointers.get(e.pointerId);
    if (rec && rec.type !== 'mouse' && !rec.down) pointers.delete(e.pointerId);
  }

  function onContextMenu(e) {
    e.preventDefault();
  }

  function onWindowPointerDown() {
    firstGesture();
  }

  function onWindowKeyDown() {
    firstGesture();
    markActivity();
  }

  // ---------------------------------------------------------------- frame

  /**
   * Advance hold timers. Call once per frame.
   * @param {number} dt seconds
   */
  function update(dt) {
    input.idleTime += dt;
    for (const rec of pointers.values()) {
      if (!rec.down) continue;
      if (rec.held) {
        rec.heldTime += dt;
        h.onHold?.({ id: rec.id, x: rec.x, y: rec.y, t: rec.heldTime });
      } else if (!rec.noHold) {
        rec.stillTime += dt;
        if (rec.stillTime >= HOLD_TIME) {
          rec.held = true;
          rec.heldTime = 0;
          h.onHoldStart?.({ id: rec.id, x: rec.x, y: rec.y });
        }
      }
    }
    if (hasPrimary && primaryId !== null) {
      const rec = pointers.get(primaryId);
      if (rec) syncPrimary(rec);
    }
  }

  // ---------------------------------------------------------------- wiring

  canvas.addEventListener('pointerdown', onPointerDown);
  canvas.addEventListener('pointermove', onPointerMove);
  canvas.addEventListener('pointerup', onPointerUp);
  canvas.addEventListener('pointercancel', onPointerCancel);
  canvas.addEventListener('pointerleave', onPointerLeave);
  canvas.addEventListener('contextmenu', onContextMenu);
  window.addEventListener('pointerdown', onWindowPointerDown, true);
  window.addEventListener('keydown', onWindowKeyDown, true);

  function dispose() {
    canvas.removeEventListener('pointerdown', onPointerDown);
    canvas.removeEventListener('pointermove', onPointerMove);
    canvas.removeEventListener('pointerup', onPointerUp);
    canvas.removeEventListener('pointercancel', onPointerCancel);
    canvas.removeEventListener('pointerleave', onPointerLeave);
    canvas.removeEventListener('contextmenu', onContextMenu);
    window.removeEventListener('pointerdown', onWindowPointerDown, true);
    window.removeEventListener('keydown', onWindowKeyDown, true);
  }

  return input;
}
