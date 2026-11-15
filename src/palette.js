// Colour seasons for Eddy. Pure maths (no DOM / GL) so it can be imported anywhere.
// Species are never raw RGB: each season gives three curated OKLCH colours plus
// pearl (balanced mixture), deep (the void) and accent (motes). Seasons crossfade in OKLab.

const DEG = Math.PI / 180;

/* ---------- OKLab <-> linear sRGB (Bjorn Ottosson) ---------- */

/** OKLab -> linear sRGB written into `out` (unclamped). */
function labToLinear(L, a, b, out) {
  const l_ = L + 0.3963377774 * a + 0.2158037573 * b;
  const m_ = L - 0.1055613458 * a - 0.0638541728 * b;
  const s_ = L - 0.0894841775 * a - 1.2914855480 * b;
  const l = l_ * l_ * l_, m = m_ * m_ * m_, s = s_ * s_ * s_;
  out[0] = 4.0767416621 * l - 3.3077115913 * m + 0.2309699292 * s;
  out[1] = -1.2684380046 * l + 2.6097574011 * m - 0.3413193965 * s;
  out[2] = -0.0041960863 * l - 0.7034186147 * m + 1.7076147010 * s;
  return out;
}

/**
 * OKLCH -> linear-light sRGB, clamped to [0,1].
 * @param {number} L lightness 0..1
 * @param {number} C chroma
 * @param {number} hDegrees hue in degrees
 * @returns {number[]} [r,g,b] linear
 */
export function oklchToLinearSrgb(L, C, hDegrees) {
  const h = hDegrees * DEG;
  const o = labToLinear(L, C * Math.cos(h), C * Math.sin(h), [0, 0, 0]);
  return [clamp01(o[0]), clamp01(o[1]), clamp01(o[2])];
}

function clamp01(x) { return x < 0 ? 0 : x > 1 ? 1 : x; }

const _tmp = [0, 0, 0];
function inGamut(L, C, h) {
  const r = labToLinear(L, C * Math.cos(h), C * Math.sin(h), _tmp);
  const e = 1e-4;
  return r[0] >= -e && r[0] <= 1 + e && r[1] >= -e && r[1] <= 1 + e && r[2] >= -e && r[2] <= 1 + e;
}

/** Gently reduce chroma until the colour sits inside sRGB. */
function clipChroma(L, C, hDeg) {
  const h = hDeg * DEG;
  if (inGamut(L, C, h)) return C;
  let lo = 0, hi = C;
  for (let i = 0; i < 14; i++) {
    const mid = (lo + hi) * 0.5;
    if (inGamut(L, mid, h)) lo = mid; else hi = mid;
  }
  return lo;
}

/* ---------- seasons: [L, C, hue] ---------- */

const KEYS = ['a', 'b', 'c', 'pearl', 'deep', 'accent'];

const SEASON_DEFS = [
  { name: 'tidepool',    // teal / coral / indigo, split-complementary
    a: [0.74, 0.115, 192], b: [0.70, 0.150, 36], c: [0.42, 0.140, 272],
    pearl: [0.95, 0.030, 95], deep: [0.105, 0.028, 228], accent: [0.89, 0.140, 168] },
  { name: 'ember moss',  // moss + ember, bruised umber third
    a: [0.60, 0.110, 128], b: [0.70, 0.170, 52], c: [0.38, 0.090, 335],
    pearl: [0.94, 0.040, 85], deep: [0.100, 0.022, 140], accent: [0.86, 0.165, 72] },
  { name: 'plum dusk',   // analogous plum-rose with one sharp gold
    a: [0.44, 0.150, 328], b: [0.70, 0.140, 8], c: [0.83, 0.130, 86],
    pearl: [0.95, 0.025, 30], deep: [0.100, 0.034, 318], accent: [0.89, 0.120, 62] },
  { name: 'glacier',     // near-monochrome blues, one hot coral
    a: [0.86, 0.045, 225], b: [0.55, 0.105, 252], c: [0.69, 0.195, 28],
    pearl: [0.97, 0.014, 215], deep: [0.100, 0.024, 245], accent: [0.92, 0.095, 198] },
  { name: 'persimmon',   // orange fruit, ink blue, pale sage
    a: [0.68, 0.180, 46], b: [0.38, 0.105, 262], c: [0.80, 0.080, 148],
    pearl: [0.96, 0.030, 75], deep: [0.100, 0.026, 28], accent: [0.87, 0.150, 58] },
  { name: 'ultraviolet', // violet, electric cyan, hot magenta
    a: [0.48, 0.200, 298], b: [0.81, 0.125, 205], c: [0.68, 0.195, 352],
    pearl: [0.95, 0.040, 290], deep: [0.085, 0.040, 285], accent: [0.90, 0.120, 196] },
  { name: 'kelp gold',   // deep kelp, bright gold, faded teal-blue
    a: [0.45, 0.095, 155], b: [0.85, 0.145, 92], c: [0.60, 0.090, 218],
    pearl: [0.96, 0.040, 100], deep: [0.100, 0.026, 168], accent: [0.91, 0.150, 100] },
  { name: 'verdigris',   // oxidised copper, rust, lilac
    a: [0.71, 0.100, 176], b: [0.54, 0.135, 40], c: [0.78, 0.085, 306],
    pearl: [0.95, 0.030, 160], deep: [0.100, 0.026, 190], accent: [0.88, 0.130, 150] },
];

// Pre-bake to gamut-clipped OKLab triples: SEASONS[i] = Float64Array(18) in KEYS order.
const SEASONS = SEASON_DEFS.map((def) => {
  const out = new Float64Array(18);
  KEYS.forEach((k, i) => {
    const [L, C, h] = def[k];
    const c = clipChroma(L, C, h);
    out[i * 3] = L;
    out[i * 3 + 1] = c * Math.cos(h * DEG);
    out[i * 3 + 2] = c * Math.sin(h * DEG);
  });
  return out;
});
const N = SEASONS.length;

const HOLD = 75;
const FADE = 25;
const QUICK_FADE = 6;
const WOBBLE = 4 * DEG;

const ease = (t) => t * t * (3 - 2 * t);

/**
 * Create the colour-season controller.
 * @returns {{update(dt:number):void, next():void, goTo(i:number):void, targetIndex:number, colors:object, seasonIndex:number, seasonName:string}}
 */
export function createPalette() {
  let idx = Math.floor(Math.random() * N);
  let nxt = (idx + 1) % N;
  let fading = false;
  let fadeT = 0;
  let fadeDur = FADE;
  let hold = Math.random() * 20; // desynchronise starts a little
  let time = Math.random() * 100;

  const from = Float64Array.from(SEASONS[idx]);
  const cur = new Float64Array(18);
  const rgb = [0, 0, 0];

  const colors = {
    a: [0, 0, 0], b: [0, 0, 0], c: [0, 0, 0],
    pearl: [0, 0, 0], deep: [0, 0, 0], accent: [0, 0, 0],
  };

  const palette = {
    colors,
    seasonIndex: idx,
    seasonName: SEASON_DEFS[idx].name,
    update,
    next,
    goTo,
    /** The season the palette is in or fading toward. */
    get targetIndex() { return fading ? nxt : idx; },
  };

  function blend() {
    const to = SEASONS[nxt];
    const e = fading ? ease(Math.min(1, fadeT)) : 0;
    for (let i = 0; i < 18; i++) cur[i] = from[i] + (to[i] - from[i]) * e;
  }

  function startFade(dur) {
    blend();
    from.set(cur); // snapshot, so a mid-fade next() does not pop
    nxt = fading ? (nxt + 1) % N : (idx + 1) % N;
    fading = true;
    fadeT = 0;
    fadeDur = dur;
  }

  function next() { startFade(QUICK_FADE); }

  /** Fade quickly to season `i` (no-op if already there or heading there). Used to follow a shared easel. */
  function goTo(i) {
    i = (((i | 0) % N) + N) % N;
    if (i === (fading ? nxt : idx)) return;
    blend();
    from.set(cur);
    nxt = i;
    fading = true;
    fadeT = 0;
    fadeDur = QUICK_FADE;
  }

  function update(dt) {
    time += dt;
    if (fading) {
      fadeT += dt / fadeDur;
      if (fadeT >= 1) {
        fading = false;
        fadeT = 0;
        idx = nxt;
        from.set(SEASONS[idx]);
        hold = 0;
      }
    } else {
      hold += dt;
      if (hold >= HOLD) startFade(FADE);
    }
    blend();
    palette.seasonIndex = fading && fadeT > 0.5 ? nxt : idx;
    palette.seasonName = SEASON_DEFS[palette.seasonIndex].name;

    // breathing hue wobble: rotate (a,b) plane a few degrees, slowly, per slot
    for (let k = 0; k < 6; k++) {
      const amp = k < 3 ? WOBBLE : k === 5 ? WOBBLE * 0.6 : WOBBLE * 0.35;
      const ang = amp * Math.sin(time * (0.045 + k * 0.011) + k * 1.9);
      const cs = Math.cos(ang), sn = Math.sin(ang);
      const A = cur[k * 3 + 1], B = cur[k * 3 + 2];
      labToLinear(cur[k * 3], A * cs - B * sn, A * sn + B * cs, rgb);
      const out = colors[KEYS[k]];
      out[0] = clamp01(rgb[0]);
      out[1] = clamp01(rgb[1]);
      out[2] = clamp01(rgb[2]);
    }
  }

  update(0);
  return palette;
}
