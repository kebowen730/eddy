// Eddy — boot, frame loop and wiring. See DESIGN.md for the module contracts.
import { getCaps } from './gl.js';
import { createSim } from './sim.js';
import { createRenderer } from './render.js';
import { createPalette } from './palette.js';
import { createMotes } from './motes.js';
import { createAudio } from './audio.js';
import { createInput } from './input.js';
import { createDrift, speciesFromAngle } from './drift.js';
import { createUI } from './ui.js';
import { createEasel, easelIdFromLocation, linkFor } from './easel.js';

const canvas = document.getElementById('stage');
const gl = canvas.getContext('webgl2', {
  alpha: false,
  antialias: false,
  depth: false,
  stencil: false,
  powerPreference: 'high-performance',
  preserveDrawingBuffer: false,
});

if (!gl || !getCaps(gl).floatTargets) {
  const fb = document.getElementById('fallback');
  if (fb) fb.hidden = false;
  document.getElementById('title')?.remove();
  throw new Error('Eddy needs WebGL2 with float render targets.');
}

// ---------------------------------------------------------------------------
// Sizing
// ---------------------------------------------------------------------------
const MAX_DPR = 2;
let aspect = 1;

function fitCanvas() {
  const dpr = Math.min(window.devicePixelRatio || 1, MAX_DPR);
  const w = Math.max(2, Math.round(canvas.clientWidth * dpr));
  const h = Math.max(2, Math.round(canvas.clientHeight * dpr));
  if (canvas.width !== w || canvas.height !== h) {
    canvas.width = w;
    canvas.height = h;
    return true;
  }
  return false;
}
fitCanvas();
aspect = canvas.width / canvas.height;

// ---------------------------------------------------------------------------
// Modules
// ---------------------------------------------------------------------------
const sim = createSim(gl, { aspect });
const renderer = createRenderer(gl);
renderer.resize(canvas.width, canvas.height);
const palette = createPalette();
const motes = createMotes(gl, { max: 220 });
const audio = createAudio();
const drift = createDrift();

let time = 0;
let tide = 0;            // 0..1 shimmer after a tide-turn
let interacted = false;  // has the player touched anything yet?
let clearTimer = 0;
let scourTimer = 0;
let frameDt = 1 / 60;    // dt of the frame being simulated (handlers run inside tick)
let remoteIdle = 1e3;    // seconds since someone else on the easel last touched the pool

// Tuning knobs for how gestures become ink. Exposed on window.__eddy for live tweaking.
const feel = {
  force: 0.55,        // stroke velocity -> fluid velocity
  dye: 0.5,           // dye per stroke splat
  hoverDye: 0.1,      // dye when the mouse merely hovers
  hoverForce: 0.3,
  radius: 0.03,       // base brush radius (fraction of height)
  radiusSpeed: 0.02,  // extra radius at high speed
  wellStrength: 0.5,
  wellRadius: 0.28,
  driftDye: 0.6,      // how much the idle autopilot paints
  wheelSpin: 0.012,   // the species wheel itself slowly rotates (rad/s)
  // shared easel
  syncEvery: 4,       // seconds between the keeper's low-res corrections
  syncBlend: 0.3,     // how far the others move toward each correction
  syncWidth: 96,      // width of a correction snapshot
  joinWidth: 192,     // width of the snapshot a newcomer receives
  // local memory
  saveEvery: 20,      // seconds between saves of the pool to localStorage
  saveWidth: 128,
};

motes.onBirth = (x, y) => audio.pluck(x, y, 0.5);
motes.onLink = (x, y, s) => audio.pluck(x, y, 0.25 + 0.5 * (s || 0));

const ui = createUI({
  onMute() {
    audio.start();
    audio.setMuted(!audio.muted);
    ui.setMuted(audio.muted);
  },
  onFullscreen() {
    if (document.fullscreenElement) document.exitFullscreen?.();
    else document.documentElement.requestFullscreen?.().catch(() => {});
  },
  onSave: savePng,
  onNextSeason() {
    palette.next();
    easel.send('season', { index: palette.targetIndex });
  },
  onClear() { clearPool(false); easel.send('clear', { scour: false }); },
  onScour() { clearPool(true); easel.send('clear', { scour: true }); },
  onShare() {
    if (!easel.id) {
      const id = easel.create();
      history.replaceState(null, '', '/e/' + id);
      saveTimer = 1; // remember it under its own name soon
    }
    return linkFor(easel.id);
  },
  onLeave() {
    savePool(true);
    easel.leave();
    history.replaceState(null, '', '/');
    ui.toast('you left the easel. the pool is yours again.');
  },
});

/** Dissolve the ink; with `scour`, wash the floor away too. */
function clearPool(scour) {
  sim.clear(1.6);
  clearTimer = 3.5;
  if (scour) { sim.scour(1.4); scourTimer = 4.5; }
}

// Everything a player does to the pool goes through these two, so it also reaches the easel.
function paint(x, y, vx, vy, species, radius, amount, quiet) {
  sim.splat(x, y, vx, vy, species, radius, amount);
  easel.splat(x, y, vx, vy, species, radius, amount, quiet);
}
function pull(x, y, strength, radius) {
  sim.well(x, y, strength, radius);
  // sim.well takes an acceleration; relay the impulse so different frame rates agree.
  easel.well(x, y, strength * frameDt, radius);
}

// ---------------------------------------------------------------------------
// Gestures
// ---------------------------------------------------------------------------
const lastPos = new Map(); // pointer id -> { x, y }
const tmpSpecies = [0, 0, 0];
const holds = new Map();   // pointer id -> charge
const pulses = [];        // { x, y, strength, radius, life, t } — short sustained wells

function pulse(x, y, strength, radius, life = 0.35) {
  pulses.push({ x, y, strength, radius, life, t: 0 });
}

function wheel(angle) {
  return speciesFromAngle(angle + time * feel.wheelSpin, tmpSpecies);
}

const input = createInput(canvas, {
  onFirstGesture() {
    interacted = true;
    audio.start();
    ui.dismissTitle();
  },
  onActivity() { ui.poke(); },

  onStroke(e) {
    const hover = !!e.hover;
    const speed = e.speed || 0;
    if (speed < 0.004) { lastPos.set(e.id, { x: e.x, y: e.y }); return; }
    const species = wheel(e.angle);
    const pressure = e.pressure ?? 1;
    const radius = feel.radius + feel.radiusSpeed * Math.min(1, speed / 2.5);
    const sp = Math.min(speed, 4);
    const k = sp / (speed || 1);
    const force = hover ? feel.hoverForce : feel.force;
    const amount = hover
      ? feel.hoverDye * Math.min(1, speed * 1.5)
      : feel.dye * pressure * (0.35 + 0.65 * Math.min(1, speed * 0.8));

    // Fill gaps between pointer samples so fast strokes stay continuous.
    const prev = lastPos.get(e.id);
    let n = 1;
    if (prev) {
      const dx = (e.x - prev.x) * aspect, dy = e.y - prev.y;
      n = Math.max(1, Math.min(12, Math.ceil(Math.hypot(dx, dy) / (radius * 0.6))));
    }
    for (let i = 1; i <= n; i++) {
      const t = i / n;
      const x = prev ? prev.x + (e.x - prev.x) * t : e.x;
      const y = prev ? prev.y + (e.y - prev.y) * t : e.y;
      paint(x, y, e.vx * k * force / n, e.vy * k * force / n, species, radius, amount / Math.sqrt(n));
    }
    if (prev) { prev.x = e.x; prev.y = e.y; } else lastPos.set(e.id, { x: e.x, y: e.y });
    if (!hover) audio.gesture({ x: e.x, y: e.y, speed, species });
  },

  onHoldStart(e) { holds.set(e.id, 0); },

  onHold(e) {
    // A well: ink is drawn inward and the point slowly charges with a turning colour.
    const charge = Math.min(1, e.t / 3);
    holds.set(e.id, charge);
    pull(e.x, e.y, feel.wellStrength * (0.3 + charge), feel.wellRadius);
    const species = wheel(e.t * 1.7);
    paint(e.x, e.y, 0, 0, species, 0.018 + 0.012 * charge, 0.05);
  },

  onHoldEnd(e) {
    const charge = holds.get(e.id) ?? Math.min(1, (e.t || 0) / 3);
    holds.delete(e.id);
    bloom(e.x, e.y, charge);
  },

  onDoubleTap(e) {
    // Turn the tide: the predator cycle reverses and every spiral unwinds.
    sim.params.chirality = sim.params.chirality > 0 ? -1 : 1;
    tide = 1;
    pulse(e.x, e.y, -1.4, 0.6, 0.5);
    audio.swell();
    easel.send('tide', { x: e.x, y: e.y, chirality: sim.params.chirality });
  },
});

/** Release of a held well: a petalled ring of all three pigments thrown outward. */
function bloom(x, y, charge) {
  const petals = 9 + Math.round(charge * 9);
  const r = 0.03 + 0.05 * charge;
  const push = 0.25 + 0.9 * charge;
  const spin = time * 0.7;
  for (let i = 0; i < petals; i++) {
    const a = (i / petals) * Math.PI * 2 + spin;
    const cx = Math.cos(a), cy = Math.sin(a);
    const sp = speciesFromAngle(a * 1.0 + spin);
    paint(x + (cx * r) / aspect, y + cy * r, (cx * push) / aspect, cy * push, sp, 0.022 + 0.02 * charge, 0.35 + 0.4 * charge);
  }
  pulse(x, y, -(1.2 + 3.0 * charge), 0.38, 0.3);
  audio.bloom(0.3 + 0.7 * charge);
}

// ---------------------------------------------------------------------------
// Shared easel: other people's hands in this pool
// ---------------------------------------------------------------------------
let syncTimer = 0;

function easelCount() { return easel.status === 'live' ? easel.peers.length + 1 : 1; }
function refreshEaselUi() {
  ui.setEasel({ status: easel.status, link: easel.id ? linkFor(easel.id) : null, count: easelCount() });
}

const easel = createEasel({
  onStatus(status) {
    refreshEaselUi();
    if (status === 'full') ui.toast('that easel is full. this pool is yours.');
  },
  onPeers(peers) {
    const n = peers.length;
    if (n > knownPeers.size) { ui.toast(n === 1 ? 'someone joined' : 'someone else joined'); audio.pluck(0.5, 0.5, 0.6); }
    else if (n < knownPeers.size && easel.status === 'live') ui.toast('someone left');
    for (const id of knownPeers) if (!peers.includes(id)) ui.dropPeer(id);
    knownPeers = new Set(peers);
    syncTimer = Math.min(syncTimer, 1);
    refreshEaselUi();
  },
  onSplat(from, x, y, vx, vy, species, radius, amount, quiet) {
    sim.splat(x, y, vx, vy, species, radius, amount);
    if (!quiet) { remoteIdle = 0; ui.remoteTouch(from, x, y); }
  },
  onWell(from, x, y, impulse, radius) {
    sim.well(x, y, impulse / frameDt, radius);
    remoteIdle = 0;
    ui.remoteTouch(from, x, y);
  },
  onEvent(from, kind, d) {
    if (kind === 'tide') {
      sim.params.chirality = d.chirality;
      tide = 1;
      audio.swell();
      ui.remoteTouch(from, d.x, d.y);
    } else if (kind === 'season') {
      palette.goTo(d.index);
    } else if (kind === 'clear') {
      clearPool(d.scour);
    } else if (kind === 'state' && from === easel.keeperId) {
      palette.goTo(d.season);
      sim.params.chirality = d.chirality;
    }
  },
  onWant(from) {
    easel.send('state', { season: palette.targetIndex, chirality: sim.params.chirality });
    easel.sendSnapshot('full', sim.capture(feel.joinWidth), from);
  },
  onSnapshot(from, kind, snap) {
    if (kind === 'full') sim.restore(snap, { blend: 1 });
    else sim.restore(snap, { blend: feel.syncBlend });
  },
});
let knownPeers = new Set();

/** The keeper periodically sends a small picture of the pool for the others to lean toward. */
function keeperSync(dt) {
  if (!easel.isKeeper || easel.peers.length === 0) { syncTimer = feel.syncEvery; return; }
  syncTimer -= dt;
  if (syncTimer > 0) return;
  syncTimer = feel.syncEvery;
  easel.send('state', { season: palette.targetIndex, chirality: sim.params.chirality });
  easel.sendSnapshot('sync', sim.capture(feel.syncWidth));
}

// ---------------------------------------------------------------------------
// Memory: the pool (ink + floor) is kept in this browser between visits
// ---------------------------------------------------------------------------
const SOLO_KEY = 'eddy:pool';
const EASEL_PREFIX = 'eddy:easel:';
const MAX_SAVED_EASELS = 4;
let saveTimer = feel.saveEvery;

function toB64(rgba, n) { // RGBA -> base64 of RGB
  let out = '';
  const CH = 8190; // multiple of 3
  const rgb = new Uint8Array(n * 3);
  for (let i = 0, j = 0; i < n; i++) { rgb[j++] = rgba[i * 4]; rgb[j++] = rgba[i * 4 + 1]; rgb[j++] = rgba[i * 4 + 2]; }
  for (let i = 0; i < rgb.length; i += CH) out += btoa(String.fromCharCode.apply(null, rgb.subarray(i, i + CH)));
  return out;
}
function fromB64(str, n) { // base64 of RGB -> RGBA, or null
  const bin = atob(str);
  if (bin.length !== n * 3) return null;
  const rgba = new Uint8Array(n * 4);
  for (let i = 0, j = 0; i < n; i++) {
    rgba[i * 4] = bin.charCodeAt(j++); rgba[i * 4 + 1] = bin.charCodeAt(j++); rgba[i * 4 + 2] = bin.charCodeAt(j++);
    rgba[i * 4 + 3] = 255;
  }
  return rgba;
}

function savePool(force) {
  if (!force && !interacted && !restored) return; // nothing of the player's to keep yet
  try {
    const snap = sim.capture(feel.saveWidth);
    const n = snap.w * snap.h;
    const key = easel.id ? EASEL_PREFIX + easel.id : SOLO_KEY;
    localStorage.setItem(key, JSON.stringify({
      v: 1, t: Date.now(), w: snap.w, h: snap.h,
      dye: toB64(snap.dye, n), bed: toB64(snap.bed, n),
      season: palette.targetIndex, chirality: sim.params.chirality,
    }));
    if (easel.id) pruneEasels();
  } catch { /* storage full or unavailable: the pool simply is not remembered */ }
}

function pruneEasels() {
  const found = [];
  for (let i = 0; i < localStorage.length; i++) {
    const k = localStorage.key(i);
    if (!k || !k.startsWith(EASEL_PREFIX)) continue;
    let t = 0;
    try { t = JSON.parse(localStorage.getItem(k)).t || 0; } catch { /* unreadable: oldest */ }
    found.push([k, t]);
  }
  found.sort((a, b) => b[1] - a[1]);
  for (const [k] of found.slice(MAX_SAVED_EASELS)) localStorage.removeItem(k);
}

let restored = false;
function loadPool(key) {
  try {
    const raw = localStorage.getItem(key);
    if (!raw) return false;
    const d = JSON.parse(raw);
    const w = d.w | 0, h = d.h | 0;
    if (d.v !== 1 || w < 1 || h < 1 || w > 512 || h > 512) return false;
    const dye = fromB64(d.dye, w * h), bed = fromB64(d.bed, w * h);
    if (!dye || !bed) return false;
    sim.restore({ w, h, dye, bed }, { blend: 1 });
    if (Number.isInteger(d.season)) palette.goTo(d.season);
    sim.params.chirality = d.chirality < 0 ? -1 : 1;
    return true;
  } catch { return false; }
}

// ---------------------------------------------------------------------------
// Save a PNG of the current frame
// ---------------------------------------------------------------------------
function savePng() {
  draw(); // render synchronously so the drawing buffer is valid for toBlob
  canvas.toBlob((blob) => {
    if (!blob) return;
    const a = document.createElement('a');
    a.href = URL.createObjectURL(blob);
    a.download = `eddy-${new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19)}.png`;
    document.body.appendChild(a);
    a.click();
    a.remove();
    setTimeout(() => URL.revokeObjectURL(a.href), 2000);
  }, 'image/png');
}

// ---------------------------------------------------------------------------
// Frame loop
// ---------------------------------------------------------------------------
let last = performance.now();
let stateTimer = 0;
let probe = null;

function draw() {
  renderer.render({
    dyeTex: sim.dyeTex,
    velocityTex: sim.velocityTex,
    dyeSize: sim.dyeSize,
    time,
    colors: palette.colors,
    chirality: sim.params.chirality,
    tide,
    bedTex: sim.bedTex,
    bedSize: sim.bedSize,
    overlay: () => motes.draw({ aspect, color: palette.colors.accent, time }),
  });
}

function frame(now) {
  requestAnimationFrame(frame);
  const dt = (now - last) / 1000;
  last = now;
  if (dt > 0) tick(dt);
}

/** Advance the whole piece by dt seconds and draw one frame. */
function tick(dt) {
  dt = Math.min(dt, 1 / 30);
  time += dt;
  frameDt = dt;
  remoteIdle += dt;

  if (fitCanvas()) {
    aspect = canvas.width / canvas.height;
    sim.resize(aspect);
    renderer.resize(canvas.width, canvas.height);
  }

  input.update(dt);
  palette.update(dt);

  // Until the player first touches the pool, the autopilot paints behind the title.
  // On a shared easel only the keeper's autopilot paints (and is relayed, quietly), and it
  // waits until everyone has been still.
  const shared = easel.status === 'live' && easel.peers.length > 0;
  const idleTime = interacted ? Math.min(input.idleTime, remoteIdle) : shared ? remoteIdle : 30;
  const splats = drift.update(dt, { idleTime, aspect, time });
  if (!shared || easel.isKeeper) {
    for (let i = 0; i < splats.length; i++) {
      const s = splats[i];
      paint(s.x, s.y, s.vx, s.vy, s.species, s.radius, s.amount * feel.driftDye, true);
    }
  }

  if (clearTimer > 0) {
    clearTimer -= dt;
    if (clearTimer <= 0) sim.clear(0);
  }
  if (scourTimer > 0) {
    scourTimer -= dt;
    if (scourTimer <= 0) sim.scour(0);
  }

  for (let i = pulses.length - 1; i >= 0; i--) {
    const p = pulses[i];
    p.t += dt;
    const k = 1 - p.t / p.life;
    if (k <= 0) { pulses.splice(i, 1); continue; }
    pull(p.x, p.y, p.strength * k, p.radius);
  }

  easel.update(dt);
  keeperSync(dt);

  sim.step(dt);
  probe = sim.probe();

  saveTimer -= dt;
  if (saveTimer <= 0) { saveTimer = feel.saveEvery; savePool(false); }

  motes.update(dt, probe, { aspect, pointer: input.primary });

  tide *= Math.exp(-dt / 1.6);

  stateTimer -= dt;
  if (stateTimer <= 0 && audio.started) {
    stateTimer = 0.1;
    audio.setState({
      balance: probe.balance,
      density: probe.density,
      energy: probe.energy,
      season: palette.seasonIndex,
      chirality: sim.params.chirality,
    });
  }

  draw();
}

canvas.addEventListener('webglcontextlost', (e) => e.preventDefault());
canvas.addEventListener('webglcontextrestored', () => location.reload());

// Come back to where you left off: an easel link restores that easel, otherwise the solo pool.
const linkedEasel = easelIdFromLocation();
if (linkedEasel) {
  restored = loadPool(EASEL_PREFIX + linkedEasel);
  ui.setHint('stir together');
  easel.join(linkedEasel);
} else {
  restored = loadPool(SOLO_KEY);
}
window.addEventListener('pagehide', () => savePool());
document.addEventListener('visibilitychange', () => { if (document.hidden) savePool(); });

// For live tuning from the console.
window.__eddy = {
  gl, sim, renderer, palette, motes, audio, input, drift, feel, tick, bloom, easel, ui, savePool, loadPool,
  get probe() { return probe; },
};

requestAnimationFrame((t) => { last = t; requestAnimationFrame(frame); });
