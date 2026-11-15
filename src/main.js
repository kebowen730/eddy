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
  onNextSeason() { palette.next(); },
  onClear() { sim.clear(1.6); clearTimer = 3.5; },
});

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
      sim.splat(x, y, e.vx * k * force / n, e.vy * k * force / n, species, radius, amount / Math.sqrt(n));
    }
    if (prev) { prev.x = e.x; prev.y = e.y; } else lastPos.set(e.id, { x: e.x, y: e.y });
    if (!hover) audio.gesture({ x: e.x, y: e.y, speed, species });
  },

  onHoldStart(e) { holds.set(e.id, 0); },

  onHold(e) {
    // A well: ink is drawn inward and the point slowly charges with a turning colour.
    const charge = Math.min(1, e.t / 3);
    holds.set(e.id, charge);
    sim.well(e.x, e.y, feel.wellStrength * (0.3 + charge), feel.wellRadius);
    const species = wheel(e.t * 1.7);
    sim.splat(e.x, e.y, 0, 0, species, 0.018 + 0.012 * charge, 0.05);
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
    sim.splat(x + (cx * r) / aspect, y + cy * r, (cx * push) / aspect, cy * push, sp, 0.022 + 0.02 * charge, 0.35 + 0.4 * charge);
  }
  pulse(x, y, -(1.2 + 3.0 * charge), 0.38, 0.3);
  audio.bloom(0.3 + 0.7 * charge);
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

  if (fitCanvas()) {
    aspect = canvas.width / canvas.height;
    sim.resize(aspect);
    renderer.resize(canvas.width, canvas.height);
  }

  input.update(dt);
  palette.update(dt);

  // Until the player first touches the pool, the autopilot paints behind the title.
  const idleTime = interacted ? input.idleTime : 30;
  const splats = drift.update(dt, { idleTime, aspect, time });
  for (let i = 0; i < splats.length; i++) {
    const s = splats[i];
    sim.splat(s.x, s.y, s.vx, s.vy, s.species, s.radius, s.amount * feel.driftDye);
  }

  if (clearTimer > 0) {
    clearTimer -= dt;
    if (clearTimer <= 0) sim.clear(0);
  }

  for (let i = pulses.length - 1; i >= 0; i--) {
    const p = pulses[i];
    p.t += dt;
    const k = 1 - p.t / p.life;
    if (k <= 0) { pulses.splice(i, 1); continue; }
    sim.well(p.x, p.y, p.strength * k, p.radius);
  }

  sim.step(dt);
  probe = sim.probe();

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

// For live tuning from the console.
window.__eddy = { gl, sim, renderer, palette, motes, audio, input, drift, feel, tick, bloom, get probe() { return probe; } };

requestAnimationFrame((t) => { last = t; requestAnimationFrame(frame); });
