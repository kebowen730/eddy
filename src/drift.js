/**
 * Idle autopilot for Eddy: a faint ambient current that is always present,
 * plus slow Lissajous "brushes" that paint on their own after the player has
 * been idle for a while. Pure JS, no DOM access.
 */

const TAU = Math.PI * 2;
const SPECIES_AMBIENT_RATE = 0.05;

/**
 * Species mix for a stroke direction. Three raised-cosine lobes 120 degrees
 * apart, squared and normalised to sum to 1.
 *
 * @param {number} angle stroke direction in radians (atan2(vy, vx))
 * @param {number[]} [out] optional array to write into (length 3)
 * @returns {number[]} [a, b, c], summing to 1
 */
export function speciesFromAngle(angle, out) {
  const o = out || [0, 0, 0];
  let sum = 0;
  for (let i = 0; i < 3; i++) {
    const c = Math.max(0, Math.cos(angle - (i * TAU) / 3));
    const w = c * c;
    o[i] = w;
    sum += w;
  }
  // The three lobes never all vanish (max cos >= 0.5), so sum > 0.
  for (let i = 0; i < 3; i++) o[i] /= sum;
  return o;
}

/** Smoothstep easing on [0,1]. */
function smooth(t) {
  const c = t < 0 ? 0 : t > 1 ? 1 : t;
  return c * c * (3 - 2 * c);
}

/** Uniform random in [lo, hi). */
function rand(lo, hi) {
  return lo + Math.random() * (hi - lo);
}

/**
 * @typedef {Object} Splat
 * @property {number} x
 * @property {number} y
 * @property {number} vx
 * @property {number} vy
 * @property {number[]} species
 * @property {number} radius
 * @property {number} amount
 */

/** @returns {Splat} */
function makeSplat() {
  return { x: 0.5, y: 0.5, vx: 0, vy: 0, species: [0, 0, 0], radius: 0.04, amount: 0 };
}

/**
 * Create the autopilot. Splat objects are pooled; the array returned by
 * `update` is reused every call, so consume it before the next frame.
 *
 * @returns {{
 *   update: (dt: number, ctx: {idleTime:number, aspect:number, time:number}) => Splat[]
 * }}
 */
export function createDrift() {
  const pool = [makeSplat(), makeSplat(), makeSplat()];
  const out = [];

  let ramp = 0; // raw 0..1 ramp over ~6 s of idleness
  let level = 0; // eased ramp, the value used for amplitudes

  /** Per-brush state. */
  const brushes = [0, 1].map((i) => ({
    // Lissajous frequency ratios (nx, ny) and random phases.
    nx: i === 0 ? 3 : 4,
    ny: i === 0 ? 2 : 3,
    px: rand(0, TAU),
    py: rand(0, TAU),
    pd1: rand(0, TAU),
    pd2: rand(0, TAU),
    radius: rand(0.035, 0.05),
    paint: rand(6, 12), // seconds of painting before lifting off
    lift: 0, // seconds remaining lifted off
  }));

  const OMEGA = 0.1; // base angular frequency, rad/s

  /** Brush position on the canvas at absolute time t (UV). */
  function brushPos(b, t, out2) {
    const fx = b.nx * (1 + 0.08 * Math.sin(0.021 * t + b.pd1));
    const fy = b.ny * (1 + 0.08 * Math.sin(0.017 * t + b.pd2));
    out2.x = 0.5 + 0.36 * Math.sin(OMEGA * fx * t + b.px);
    out2.y = 0.5 + 0.34 * Math.cos(OMEGA * fy * t + b.py);
    return out2;
  }

  const posA = { x: 0, y: 0 };
  const posB = { x: 0, y: 0 };

  /**
   * Advance the autopilot one frame.
   *
   * @param {number} dt seconds since last frame
   * @param {{idleTime:number, aspect:number, time:number}} ctx
   * @returns {Splat[]} splats to inject this frame
   */
  function update(dt, ctx) {
    const idle = ctx.idleTime;
    const time = ctx.time;
    const step = dt > 0 ? dt : 1 / 60;

    // Ramp the autopilot in after 8 s idle; snap out on any interaction.
    if (idle < 0.5) {
      ramp = 0;
      for (const b of brushes) {
        b.paint = rand(6, 12);
        b.lift = 0;
      }
    } else if (idle > 8) {
      ramp = Math.min(1, ramp + step / 6);
    }
    level = smooth(ramp);

    out.length = 0;

    // Ambient current: always present, force only, very faint.
    const amb = pool[0];
    amb.x = 0.5 + 0.35 * Math.sin(0.031 * time) + 0.12 * Math.sin(0.047 * time + 1.7);
    amb.y = 0.5 + 0.35 * Math.sin(0.027 * time + 0.9) + 0.12 * Math.sin(0.052 * time + 4.1);
    amb.x = Math.min(0.98, Math.max(0.02, amb.x));
    amb.y = Math.min(0.98, Math.max(0.02, amb.y));
    amb.vx = 0.02 * Math.cos(0.05 * time + 0.3);
    amb.vy = 0.02 * Math.sin(0.043 * time + 2.2);
    speciesFromAngle(time * SPECIES_AMBIENT_RATE, amb.species);
    amb.radius = 0.06;
    amb.amount = 0;
    out.push(amb);

    if (level <= 0) return out;

    // Autopilot brushes.
    for (let i = 0; i < brushes.length; i++) {
      const b = brushes[i];
      if (b.lift > 0) {
        b.lift -= step;
        if (b.lift <= 0) {
          b.lift = 0;
          b.paint = rand(10, 20);
        }
        continue;
      }
      b.paint -= step;
      if (b.paint <= 0) {
        b.lift = rand(2, 5);
        continue;
      }

      // Velocity from the path derivative: backward difference over one step.
      brushPos(b, time, posA);
      brushPos(b, time - step, posB);
      const vx = (posA.x - posB.x) / step;
      const vy = (posA.y - posB.y) / step;

      const s = pool[i + 1];
      s.x = posA.x;
      s.y = posA.y;
      s.vx = vx;
      s.vy = vy;
      speciesFromAngle(Math.atan2(vy, vx), s.species);
      s.radius = b.radius;
      s.amount = 0.25 * level;
      out.push(s);
    }

    return out;
  }

  return { update };
}
