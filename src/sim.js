// Eddy simulation: stable-fluids solver + three-species cyclic (May-Leonard) reaction, all on the GPU.
//
// Coordinates are normalised UV (x right, y UP, both 0..1). Velocities are UV/s, with x measured in
// x-UV (so vx = 1 crosses the whole width per second) and advection is simply `uv - dt * vel`.
// The pressure solve works in "square cell" physical units, so x components are scaled by the aspect
// ratio where it matters (divergence, gradient, curl, splat distances, front force).

import {
  FULLSCREEN_VS, createProgram, createFBO, createDoubleFBO, drawFullscreen, bindTex, getCaps,
} from './gl.js';

const HEAD = `#version 300 es
precision highp float;
precision highp sampler2D;
`;

// Manual bilinear filtering, used when float textures can't be filtered linearly.
const SAMPLE_CHUNK = `
vec4 bilerp(sampler2D s, vec2 uv) {
  vec2 sz = vec2(textureSize(s, 0));
  vec2 st = uv * sz - 0.5;
  vec2 i = floor(st);
  vec2 f = st - i;
  vec2 b = (i + 0.5) / sz;
  vec2 tx = 1.0 / sz;
  vec4 p00 = texture(s, b);
  vec4 p10 = texture(s, b + vec2(tx.x, 0.0));
  vec4 p01 = texture(s, b + vec2(0.0, tx.y));
  vec4 p11 = texture(s, b + tx);
  return mix(mix(p00, p10, f.x), mix(p01, p11, f.x), f.y);
}
`;

// ---------------------------------------------------------------------------------------------
// Fragment shaders
// ---------------------------------------------------------------------------------------------

// Semi-Lagrangian advection of any texture by the velocity field. Dissipation is a multiplier.
const ADVECT_FS = HEAD + `
in vec2 vUv;
out vec4 fragColor;
uniform sampler2D uVelocity;
uniform sampler2D uSource;
uniform float uDt;
uniform float uDissipation;
uniform bool uManual;
uniform bool uWalls;
` + SAMPLE_CHUNK + `
vec4 samp(sampler2D s, vec2 uv) { return uManual ? bilerp(s, uv) : texture(s, uv); }
void main() {
  vec2 vel = samp(uVelocity, vUv).xy;
  vec2 coord = vUv - uDt * vel;
  vec3 v = samp(uSource, coord).rgb * uDissipation;
  if (uWalls) {
    vec2 t = 1.0 / vec2(textureSize(uSource, 0));
    if (vUv.x < t.x || vUv.x > 1.0 - t.x) v.x = 0.0;
    if (vUv.y < t.y || vUv.y > 1.0 - t.y) v.y = 0.0;
  }
  fragColor = vec4(v, 1.0);
}`;

// Scalar curl of the velocity field (physical units), stored in .x
const CURL_FS = HEAD + `
in vec2 vUv;
out vec4 fragColor;
uniform sampler2D uVelocity;
uniform float uAspect;
void main() {
  vec2 t = 1.0 / vec2(textureSize(uVelocity, 0));
  float L = texture(uVelocity, vUv - vec2(t.x, 0.0)).y;
  float R = texture(uVelocity, vUv + vec2(t.x, 0.0)).y;
  float T = texture(uVelocity, vUv + vec2(0.0, t.y)).x;
  float B = texture(uVelocity, vUv - vec2(0.0, t.y)).x;
  fragColor = vec4(0.5 * ((R - L) - uAspect * (T - B)), 0.0, 0.0, 1.0);
}`;

// Vorticity confinement + dye-driven "front force"; also the sediment bed's steering (heavy ink
// slides downhill, flow turns along contours, shoals drag); finally clamps the maximum speed.
const VORTICITY_FS = HEAD + `
in vec2 vUv;
out vec4 fragColor;
uniform sampler2D uVelocity;
uniform sampler2D uCurl;
uniform sampler2D uDye;
uniform sampler2D uBed;
uniform float uDt;
uniform float uVorticity;
uniform float uFrontForce;
uniform float uChi;
uniform float uAspect;
uniform float uMaxVel;
uniform bool uManual;
uniform float uBedSlope;
uniform float uBedDeflect;
uniform float uBedDrag;
` + SAMPLE_CHUNK + `
float bedH(vec2 uv) {
  vec3 b = uManual ? bilerp(uBed, uv).rgb : texture(uBed, uv).rgb;
  return b.r + b.g + b.b;
}
void main() {
  vec2 t = 1.0 / vec2(textureSize(uVelocity, 0));
  float cL = texture(uCurl, vUv - vec2(t.x, 0.0)).x;
  float cR = texture(uCurl, vUv + vec2(t.x, 0.0)).x;
  float cT = texture(uCurl, vUv + vec2(0.0, t.y)).x;
  float cB = texture(uCurl, vUv - vec2(0.0, t.y)).x;
  float cC = texture(uCurl, vUv).x;
  vec2 f = 0.5 * vec2(abs(cT) - abs(cB), abs(cR) - abs(cL));
  f /= length(f) + 1e-4;
  f *= uVorticity * cC;
  f.y = -f.y;

  // Fronts between species gently swirl the fluid: force along the perpendicular of grad(a - b).
  vec3 dL = texture(uDye, vUv - vec2(t.x, 0.0)).rgb;
  vec3 dR = texture(uDye, vUv + vec2(t.x, 0.0)).rgb;
  vec3 dT = texture(uDye, vUv + vec2(0.0, t.y)).rgb;
  vec3 dB = texture(uDye, vUv - vec2(0.0, t.y)).rgb;
  vec3 dC = texture(uDye, vUv).rgb;
  vec2 g = 0.5 * vec2((dR.r - dR.g) - (dL.r - dL.g), (dT.r - dT.g) - (dB.r - dB.g));
  f += vec2(-g.y, g.x) * (uChi * uFrontForce * 10.0);

  // Bed relief, sampled one *velocity* texel away so the gradient is smooth even though the bed
  // lives on the finer dye grid. Gradient is per velocity cell, normalised to a 160-row grid so
  // the feel does not change between the desktop and mobile grid sizes.
  float hC = bedH(vUv);
  float hL = bedH(vUv - vec2(t.x, 0.0));
  float hR = bedH(vUv + vec2(t.x, 0.0));
  float hT = bedH(vUv + vec2(0.0, t.y));
  float hB = bedH(vUv - vec2(0.0, t.y));
  vec2 gh = 0.5 * vec2(hR - hL, hT - hB) * (float(textureSize(uVelocity, 0).y) / 160.0);
  float rho = dC.r + dC.g + dC.b;
  // K = 3: slope 0.5, ink density ~0.8 and a unit step over ~4 cells (gh ~ 0.25) -> ~0.3 heights/s^2
  f += -uBedSlope * rho * gh * 3.0;

  f.x /= uAspect; // physical -> UV-x
  vec2 v = texture(uVelocity, vUv).xy + f * uDt;

  // Flow heading uphill is turned along the contours: remove a fraction of its uphill component.
  // S = 4: on a steep ridge (|gh| ~ 0.25) with bedDeflect = 3 the rate is ~3/s, so most of the
  // uphill flow is gone within about a second; on gentle slopes (|gh| ~ 0.02) it is ~0.25/s.
  float sm = length(gh);
  vec2 nrm = gh / max(sm, 1e-6);
  float up = max(dot(v * vec2(uAspect, 1.0), nrm), 0.0);
  float fr = 1.0 - exp(-uBedDeflect * sm * uDt * 4.0);
  v -= (nrm * (up * fr)) / vec2(uAspect, 1.0); // applied as a delta so an empty bed is a no-op
  v *= exp(-uBedDrag * hC * uDt);

  float sp = length(v);
  if (sp > uMaxVel) v *= uMaxVel / sp;
  fragColor = vec4(v, 0.0, 1.0);
}`;

const DIVERGENCE_FS = HEAD + `
in vec2 vUv;
out vec4 fragColor;
uniform sampler2D uVelocity;
uniform float uAspect;
void main() {
  vec2 t = 1.0 / vec2(textureSize(uVelocity, 0));
  vec2 C = texture(uVelocity, vUv).xy;
  vec2 L = texture(uVelocity, vUv - vec2(t.x, 0.0)).xy;
  vec2 R = texture(uVelocity, vUv + vec2(t.x, 0.0)).xy;
  vec2 T = texture(uVelocity, vUv + vec2(0.0, t.y)).xy;
  vec2 B = texture(uVelocity, vUv - vec2(0.0, t.y)).xy;
  // closed box: reflect the normal component at the walls
  if (vUv.x - t.x < 0.0) L.x = -C.x;
  if (vUv.x + t.x > 1.0) R.x = -C.x;
  if (vUv.y + t.y > 1.0) T.y = -C.y;
  if (vUv.y - t.y < 0.0) B.y = -C.y;
  fragColor = vec4(0.5 * (uAspect * (R.x - L.x) + (T.y - B.y)), 0.0, 0.0, 1.0);
}`;

const PRESSURE_FS = HEAD + `
in vec2 vUv;
out vec4 fragColor;
uniform sampler2D uPressure;
uniform sampler2D uDivergence;
uniform float uScale; // <1 on the first iteration to decay the warm start
void main() {
  vec2 t = 1.0 / vec2(textureSize(uPressure, 0));
  float L = texture(uPressure, vUv - vec2(t.x, 0.0)).x;
  float R = texture(uPressure, vUv + vec2(t.x, 0.0)).x;
  float T = texture(uPressure, vUv + vec2(0.0, t.y)).x;
  float B = texture(uPressure, vUv - vec2(0.0, t.y)).x;
  float div = texture(uDivergence, vUv).x;
  fragColor = vec4((uScale * (L + R + T + B) - div) * 0.25, 0.0, 0.0, 1.0);
}`;

const GRADIENT_FS = HEAD + `
in vec2 vUv;
out vec4 fragColor;
uniform sampler2D uPressure;
uniform sampler2D uVelocity;
uniform float uAspect;
void main() {
  vec2 t = 1.0 / vec2(textureSize(uPressure, 0));
  float L = texture(uPressure, vUv - vec2(t.x, 0.0)).x;
  float R = texture(uPressure, vUv + vec2(t.x, 0.0)).x;
  float T = texture(uPressure, vUv + vec2(0.0, t.y)).x;
  float B = texture(uPressure, vUv - vec2(0.0, t.y)).x;
  vec2 v = texture(uVelocity, vUv).xy;
  v -= 0.5 * vec2((R - L) / uAspect, T - B);
  // no flow through the walls
  if (vUv.x < t.x || vUv.x > 1.0 - t.x) v.x = 0.0;
  if (vUv.y < t.y || vUv.y > 1.0 - t.y) v.y = 0.0;
  fragColor = vec4(v, 0.0, 1.0);
}`;

// Velocity splat: adds uValue * gaussian.
const SPLAT_VEL_FS = HEAD + `
in vec2 vUv;
out vec4 fragColor;
uniform sampler2D uTarget;
uniform vec2 uPoint;
uniform vec2 uValue;
uniform float uRadius;
uniform float uAspect;
void main() {
  vec2 p = vUv - uPoint;
  p.x *= uAspect; // round on screen; radius is a fraction of height
  float f = exp(-dot(p, p) / (uRadius * uRadius));
  vec4 base = texture(uTarget, vUv);
  fragColor = vec4(base.xy + uValue * f, base.zw);
}`;

// Dye splat: adds uValue * gaussian, then soft-limits the total to ~1.2 (only where paint was added).
const SPLAT_DYE_FS = HEAD + `
in vec2 vUv;
out vec4 fragColor;
uniform sampler2D uTarget;
uniform vec2 uPoint;
uniform vec3 uValue;
uniform float uRadius;
uniform float uAspect;
void main() {
  vec2 p = vUv - uPoint;
  p.x *= uAspect;
  float f = exp(-dot(p, p) / (uRadius * uRadius));
  vec3 col = texture(uTarget, vUv).rgb + uValue * f;
  float s = col.r + col.g + col.b;
  if (s > 1.0) {
    float tot = 1.0 + 0.2 * (1.0 - exp(-(s - 1.0) / 0.2)); // asymptotes at 1.2
    col = mix(col, col * (tot / s), smoothstep(0.0, 0.02, f));
  }
  fragColor = vec4(min(col, vec3(1.5)), 1.0);
}`;

// Well: radial acceleration (toward the point when uStrength > 0) with smooth falloff, plus a little swirl.
const WELL_FS = HEAD + `
in vec2 vUv;
out vec4 fragColor;
uniform sampler2D uTarget;
uniform vec2 uPoint;
uniform float uStrength; // acceleration * dt, UV/s gained
uniform float uRadius;
uniform float uAspect;
uniform float uSwirl;
void main() {
  vec2 dp = (uPoint - vUv) * vec2(uAspect, 1.0);
  float r = length(dp);
  float t = clamp(1.0 - r / uRadius, 0.0, 1.0);
  float w = t * t * (3.0 - 2.0 * t);
  vec2 dir = dp / sqrt(dot(dp, dp) + 0.01 * uRadius * uRadius); // softened unit vector
  vec2 tang = vec2(-dir.y, dir.x);
  vec2 acc = (dir + uSwirl * tang) * (w * uStrength);
  acc.x /= uAspect;
  vec4 base = texture(uTarget, vUv);
  fragColor = vec4(base.xy + acc, base.zw);
}`;

// Shared by the reaction and the bed's deposit pass so "dying" means exactly the same thing in both.
// Bed fertility lowers the Allee threshold: old sediment makes ink thrive at lower density.
const REACT_STATE_CHUNK = `
uniform float uAllee;
uniform float uPureLo;
uniform float uPureHi;
uniform float uBedMax;
uniform float uBedFert;
float bedFert(float h) { return uBedFert * clamp(h / max(uBedMax, 1e-3), 0.0, 1.0); }
void reactState(vec3 c, float fert, out float rho, out float gate, out float live) {
  rho = c.r + c.g + c.b;
  float allee = uAllee * (1.0 - 0.6 * fert);
  gate = smoothstep(allee * 0.5, allee * 1.5, rho);
  // Ink only thrives where the chase is happening: a region owned by a single species
  // stops growing and slowly starves, so flat fields thin out to veils and the void returns.
  float purity = max(c.r, max(c.g, c.b)) / max(rho, 1e-4);
  live = 1.0 - smoothstep(uPureLo, uPureHi, purity);
}
`;

// The heart of the game: cyclic competition with diffusion, one explicit Euler substep.
//   d s_i/dt = s_i * (growth*gate*(1-rho) - predation*P_i - decay - fade*(1-gate)) + D * lap(s_i)
// P_i = density of the species that preys on i. Chirality blends between the two cycle directions.
// "gate" is an Allee term: below rho ~ allee the dye cannot grow and fades away instead.
const REACT_FS = HEAD + `
in vec2 vUv;
out vec4 fragColor;
uniform sampler2D uDye;
uniform sampler2D uBed;
uniform float uDt;
uniform float uGrowth;
uniform float uPred;
uniform float uDecay;
uniform float uDiff;   // diffusion in cell^2 / s
uniform float uChi;    // smoothed chirality in [-1, 1]
uniform float uFade;
uniform float uFloor;
uniform float uStarve;
` + REACT_STATE_CHUNK + `
void main() {
  vec2 t = 1.0 / vec2(textureSize(uDye, 0));
  vec3 c  = texture(uDye, vUv).rgb;
  vec3 n  = texture(uDye, vUv + vec2(0.0, t.y)).rgb;
  vec3 s  = texture(uDye, vUv - vec2(0.0, t.y)).rgb;
  vec3 e  = texture(uDye, vUv + vec2(t.x, 0.0)).rgb;
  vec3 w  = texture(uDye, vUv - vec2(t.x, 0.0)).rgb;
  vec3 ne = texture(uDye, vUv + t).rgb;
  vec3 nw = texture(uDye, vUv + vec2(-t.x, t.y)).rgb;
  vec3 se = texture(uDye, vUv + vec2(t.x, -t.y)).rgb;
  vec3 sw = texture(uDye, vUv - t).rgb;
  // isotropic 9-point Laplacian in cell units
  vec3 lap = (4.0 * (n + s + e + w) + (ne + nw + se + sw) - 20.0 * c) / 6.0;

  vec3 bd = texture(uBed, vUv).rgb;
  float fert = bedFert(bd.r + bd.g + bd.b);
  float rho, gate, live;
  reactState(c, fert, rho, gate, live);
  float wp = 0.5 + 0.5 * uChi;
  float wm = 1.0 - wp;
  // chirality +1: c eats a, a eats b, b eats c.  chirality -1: b eats a, c eats b, a eats c.
  vec3 pred = vec3(wp * c.b + wm * c.g,
                   wp * c.r + wm * c.b,
                   wp * c.g + wm * c.r);
  vec3 rate = vec3(uGrowth * (1.0 + 0.5 * fert) * gate * live * (1.0 - rho) - uDecay
                   - uStarve * (1.0 - live) - uFade * (1.0 - gate)) - uPred * pred;
  vec3 next = c + uDt * (c * rate + uDiff * lap);
  next = clamp(next, 0.0, 1.5);
  next *= step(vec3(uFloor), next); // extinction floor: vanishing species really vanish
  fragColor = vec4(next, 1.0);
}`;

// --- sediment bed -----------------------------------------------------------------------------
// bed.rgb = settled mass of species a,b,c (same grid as the dye). Scouring is shared by the lift
// pass (dye gains bedLift of it) and the bed pass (the bed loses all of it), so both must compute
// it from the same inputs: the pre-update bed and the velocity.
const SCOUR_CHUNK = `
uniform float uAspect;
uniform float uBedErode;
uniform float uBedErodeLo;
uniform float uBedErodeHi;
vec3 scourAmt(vec3 bed, vec2 vel, float dt) {
  float sp = length(vel * vec2(uAspect, 1.0)); // physical speed, heights/s
  float k = uBedErode * smoothstep(uBedErodeLo, uBedErodeHi, sp) * dt;
  return bed * min(k, 1.0);
}
`;

// Lift: scoured silt rises back into the water as ink of its old colour.
const LIFT_FS = HEAD + `
in vec2 vUv;
out vec4 fragColor;
uniform sampler2D uDye;
uniform sampler2D uBed;
uniform sampler2D uVelocity;
uniform float uDt;
uniform float uLift;
` + SCOUR_CHUNK + `
void main() {
  vec3 d = texture(uDye, vUv).rgb;
  vec3 b = texture(uBed, vUv).rgb;
  vec2 vel = texture(uVelocity, vUv).xy;
  d += uLift * scourAmt(b, vel, uDt);
  fragColor = vec4(clamp(d, 0.0, 1.5), 1.0);
}`;

// Bed update. uDye is the dye AFTER the lift pass, i.e. exactly what the reaction will then kill,
// so deposit is a fraction of the real death flux; the lifted silt is only ever bedLift of what
// the bed lost, so no mass is created.
const BED_FS = HEAD + `
in vec2 vUv;
out vec4 fragColor;
uniform sampler2D uDye;
uniform sampler2D uBed;
uniform sampler2D uVelocity;
uniform float uDt;       // real frame dt (scour, settling)
uniform float uTs;       // dt * timeScale (deposit follows the reaction clock)
uniform float uDeposit;
uniform float uDecay;
uniform float uStarve;
uniform float uFade;
uniform float uSettle;   // total uniform decay rate: bedSettle + scour(rate)
uniform float uSmoothK;  // bedSmooth * dt, <= 0.2
uniform float uFadeShare;
uniform float uSeed;
` + REACT_STATE_CHUNK + SCOUR_CHUNK + `
// The bed changes by less than one half-float step per frame. Some GPUs truncate when they
// store to a 16F target, which would drain the floor by a step every frame, so round to the
// half-float grid ourselves, stochastically, which is unbiased whatever the hardware does.
float hash31(vec3 p) {
  p = fract(p * vec3(0.1031, 0.1030, 0.0973));
  p += dot(p, p.yzx + 33.33);
  return fract((p.x + p.y) * p.z);
}
vec3 quantize(vec3 v) {
  vec3 ulp = exp2(floor(log2(max(v, vec3(1e-5)))) - 10.0);
  vec3 r = vec3(hash31(vec3(gl_FragCoord.xy, uSeed)),
                hash31(vec3(gl_FragCoord.yx + 19.7, uSeed + 3.1)),
                hash31(vec3(gl_FragCoord.xy + 71.3, uSeed + 7.7)));
  return floor(v / ulp + r) * ulp;
}
void main() {
  vec2 t = 1.0 / vec2(textureSize(uBed, 0));
  vec3 b  = texture(uBed, vUv).rgb;
  vec3 bn = texture(uBed, vUv + vec2(0.0, t.y)).rgb;
  vec3 bs = texture(uBed, vUv - vec2(0.0, t.y)).rgb;
  vec3 be = texture(uBed, vUv + vec2(t.x, 0.0)).rgb;
  vec3 bw = texture(uBed, vUv - vec2(t.x, 0.0)).rgb;
  vec3 lap = bn + bs + be + bw - 4.0 * b;

  vec3 c = texture(uDye, vUv).rgb;
  vec2 vel = texture(uVelocity, vUv).xy;
  float h = b.r + b.g + b.b;
  float rho, gate, live;
  reactState(c, bedFert(h), rho, gate, live);
  // Thin veils fading at the edge of every stroke count for less than ink that starved in place,
  // otherwise each brush halo lays down floor at once.
  vec3 dying = c * (uDecay + uStarve * (1.0 - live) + uFadeShare * uFade * (1.0 - gate));
  float room = clamp(1.0 - h / max(uBedMax, 1e-3), 0.0, 1.0); // soft cap: saturates smoothly
  vec3 dep = min(uDeposit * dying * uTs * room, c);

  vec3 nb = (b - scourAmt(b, vel, uDt)) * exp(-uSettle * uDt) + uSmoothK * lap + dep;
  nb = max(nb, 0.0);
  nb *= step(vec3(1e-4), nb);
  fragColor = vec4(quantize(nb), 1.0);
}`;

const COPY_FS = HEAD + `
in vec2 vUv;
out vec4 fragColor;
uniform sampler2D uSrc;
void main() { fragColor = texture(uSrc, vUv); }`;

// Area-average downsample for the CPU probe. Mode 0: dye -> rgb. Mode 1: velocity -> encoded rg.
const PROBE_FS = HEAD + `
in vec2 vUv;
out vec4 fragColor;
uniform sampler2D uSrc;
uniform vec2 uFoot;   // footprint of one output texel in UV
uniform int uMode;
uniform float uScale;
void main() {
  vec4 acc = vec4(0.0);
  for (int j = 0; j < 4; j++) {
    for (int i = 0; i < 4; i++) {
      vec2 o = (vec2(float(i), float(j)) + 0.5) / 4.0 - 0.5;
      acc += texture(uSrc, vUv + o * uFoot);
    }
  }
  acc /= 16.0;
  vec3 v;
  if (uMode == 0) v = clamp(acc.rgb, 0.0, 1.0);
  else v = vec3(clamp(acc.rg * uScale * 0.5 + 0.5, 0.0, 1.0), 0.5);
  fragColor = vec4(v, 1.0);
}`;

// Area-average downsample for snapshots. uTaps = taps per axis across one output texel's footprint
// (sized to the source/target ratio, max 8x8, so a big ratio does not alias like one bilinear tap).
// uEncode = 1: write sqrt(clamp(v / 1.5, 0, 1)) for the RGBA8 snapshot; 0: raw float for the
// low-pass used by restore's nudge.
const CAPTURE_FS = HEAD + `
in vec2 vUv;
out vec4 fragColor;
uniform sampler2D uSrc;
uniform vec2 uFoot;
uniform vec2 uTaps;
uniform int uEncode;
uniform bool uManual;
` + SAMPLE_CHUNK + `
void main() {
  int nx = int(uTaps.x + 0.5);
  int ny = int(uTaps.y + 0.5);
  vec3 acc = vec3(0.0);
  for (int j = 0; j < 8; j++) {
    if (j >= ny) break;
    for (int i = 0; i < 8; i++) {
      if (i >= nx) break;
      vec2 o = (vec2(float(i), float(j)) + 0.5) / uTaps - 0.5;
      vec2 uv = vUv + o * uFoot;
      acc += uManual ? bilerp(uSrc, uv).rgb : texture(uSrc, uv).rgb;
    }
  }
  acc /= float(nx * ny);
  if (uEncode == 1) acc = sqrt(clamp(acc / 1.5, 0.0, 1.0));
  fragColor = vec4(acc, 1.0);
}`;

// Decode an uploaded snapshot (v = (byte/255)^2 * 1.5), bilinearly upsample it, and either write it
// (uUseBlend = 0) or nudge the field: max(0, x + blend * (S - L)). Taps are decoded before they are
// interpolated so S lives in the same linear space as the float low-pass L.
const RESTORE_FS = HEAD + `
in vec2 vUv;
out vec4 fragColor;
uniform sampler2D uSnap;
uniform sampler2D uLocal;
uniform sampler2D uField;
uniform float uBlend;
uniform int uUseBlend;
uniform bool uManualL;
` + SAMPLE_CHUNK + `
vec3 dec(vec3 e) { return e * e * 1.5; }
vec3 snapAt(vec2 uv) {
  vec2 sz = vec2(textureSize(uSnap, 0));
  vec2 st = uv * sz - 0.5;
  vec2 i = floor(st);
  vec2 f = st - i;
  vec2 b = (i + 0.5) / sz;
  vec2 tx = 1.0 / sz;
  vec3 p00 = dec(texture(uSnap, b).rgb);
  vec3 p10 = dec(texture(uSnap, b + vec2(tx.x, 0.0)).rgb);
  vec3 p01 = dec(texture(uSnap, b + vec2(0.0, tx.y)).rgb);
  vec3 p11 = dec(texture(uSnap, b + tx).rgb);
  return mix(mix(p00, p10, f.x), mix(p01, p11, f.x), f.y);
}
void main() {
  vec3 S = snapAt(vUv);
  vec3 o = S;
  if (uUseBlend == 1) {
    vec3 x = texture(uField, vUv).rgb;
    vec3 L = uManualL ? bilerp(uLocal, vUv).rgb : texture(uLocal, vUv).rgb;
    o = max(x + uBlend * (S - L), 0.0);
  }
  fragColor = vec4(clamp(o, 0.0, 1.5), 1.0);
}`;

// ---------------------------------------------------------------------------------------------

const MAX_QUEUE = 160;
const PROBE_INTERVAL = 6; // frames

/**
 * Create the fluid + reaction simulation.
 * @param {WebGL2RenderingContext} gl
 * @param {{aspect:number}} opts canvas aspect ratio (width/height)
 * @returns the sim object described in DESIGN.md
 */
export function createSim(gl, { aspect = 1 } = {}) {
  const caps = getCaps(gl);
  // When float textures can't be linearly filtered we do bilinear taps by hand in the advect shader.
  const manual = caps.floatTargets && !caps.linearFloat;

  /** Live tunables. Mutate freely; read every step. */
  const params = {
    chirality: 1,            // +1 / -1: direction of the predator cycle
    growth: 0.9,             // logistic growth rate (1/s)
    predation: 1.6,          // loss rate of a species per unit density of its predator (1/s)
    decay: 0.02,             // baseline death rate (1/s)
    diffusion: 2e-4,         // height^2 / s  (front width ~ sqrt(D/growth) ~ 1.5% of height)
    allee: 0.2,             // total density below which dye cannot grow and fades away
    starve: 0.06,           // decay rate (1/s) of regions owned by a single species
    pureLo: 0.62, pureHi: 0.97, // purity range over which a region goes from thriving to starving
    voidFade: 1.5,           // fade rate (1/s) of sub-threshold dye
    extinctionFloor: 1e-4,   // species densities below this snap to zero
    timeScale: 1,            // speed of the reaction relative to the fluid
    maxSubsteps: 10,         // reaction substeps per frame (cap)
    chiRate: 2.5,            // how fast the smoothed chirality follows params.chirality (1/s)
    vorticity: 14,           // vorticity confinement strength (1/s)
    velocityDissipation: 0.6,// velocity *= exp(-k dt)
    pressureIterations: 18,
    pressureDecay: 0.8,      // warm-start decay of the pressure field
    splatForce: 1,           // multiplier on velocity splats
    frontForce: 0.02,        // swirl force at species fronts (0 disables)
    maxVelocity: 4,          // speed clamp (UV/s)
    wellSwirl: 0.25,         // tangential fraction of a well's pull
    probeVelScale: 4,
    // --- sediment bed (see DESIGN.md v2) ---
    bedDeposit: 0.1,          // fraction of dying ink mass that settles (0 disables sediment)
    bedMax: 1.0,             // soft cap on bed height
    bedErode: 0.35,           // scour rate (1/s) of the bed under full-speed flow
    bedErodeLo: 0.25,        // flow speed (heights/s) where scouring starts
    bedErodeHi: 1.2,         // flow speed where scouring is at full rate
    bedLift: 0.5,            // fraction of scoured sediment that returns to the water as ink
    bedSettle: 0.003,        // slow uniform decay of the bed (1/s)
    bedSmooth: 0.6,          // diffusion of the bed in cell^2/s, keeps relief smooth
    bedFadeShare: 0.6,       // how much void-fade loss counts toward deposit, relative to starvation
    bedDrag: 1.0,            // extra velocity damping (1/s) per unit bed height
    bedDeflect: 3.0,         // how strongly flow heading uphill is turned along the contours
    bedSlope: 0.5,           // downhill acceleration of ink: f = -bedSlope * rho * grad(h)
    bedFertility: 0.3,       // 0..1: how much a full bed lowers the Allee threshold / boosts growth
  };

  // --- programs ---
  const mk = (fs) => createProgram(gl, FULLSCREEN_VS, fs);
  const progAdvect = mk(ADVECT_FS);
  const progCurl = mk(CURL_FS);
  const progVort = mk(VORTICITY_FS);
  const progDiv = mk(DIVERGENCE_FS);
  const progPress = mk(PRESSURE_FS);
  const progGrad = mk(GRADIENT_FS);
  const progSplatVel = mk(SPLAT_VEL_FS);
  const progSplatDye = mk(SPLAT_DYE_FS);
  const progWell = mk(WELL_FS);
  const progReact = mk(REACT_FS);
  const progCopy = mk(COPY_FS);
  const progProbe = mk(PROBE_FS);
  const progLift = mk(LIFT_FS);
  const progBed = mk(BED_FS);
  const progCapture = mk(CAPTURE_FS);
  const progRestore = mk(RESTORE_FS);

  // Uniform setters (null/undefined locations are no-ops in WebGL).
  const f1 = (p, n, v) => gl.uniform1f(p.uniforms[n] ?? null, v);
  const f2 = (p, n, x, y) => gl.uniform2f(p.uniforms[n] ?? null, x, y);
  const f3 = (p, n, x, y, z) => gl.uniform3f(p.uniforms[n] ?? null, x, y, z);
  const i1 = (p, n, v) => gl.uniform1i(p.uniforms[n] ?? null, v);
  const tex = (p, n, t, unit) => bindTex(gl, p.uniforms[n] ?? null, t, unit);

  // --- state ---
  let curAspect = aspect;
  let velocity, dye, curl, divergence, pressure, bed;
  let probeFboDye = null, probeFboVel = null, probeFboBed = null;
  let scourRate = 0;
  const captureCache = new Map(); // "WxH" -> { dye: fbo, bed: fbo } RGBA8 targets
  let lowFbo = null;              // float low-pass target reused by restore's nudge
  let dyeSizeArr = [1, 1];
  let chi = params.chirality;
  let clearRate = 0;
  let frame = 0;
  let lastProbeFrame = -1000;
  const splatQueue = [];
  const wellQueue = [];

  const probeData = {
    w: 32, h: 32,
    dye: new Uint8Array(32 * 32 * 4),
    vel: new Uint8Array(32 * 32 * 4),
    balance: [1 / 3, 1 / 3, 1 / 3],
    density: 0,
    energy: 0,
    sediment: 0,
  };
  let probeBed = new Uint8Array(32 * 32 * 4);

  // Taps per axis for an area-average from `src` texels down to `dst` texels (1..8).
  function tapsFor(src, dst) {
    return Math.min(8, Math.max(1, Math.ceil(src / dst)));
  }

  function gridSizes(asp) {
    const small = typeof window !== 'undefined' &&
      Math.min(window.innerWidth, window.innerHeight) < 600;
    const vh = small ? 96 : 160;
    const dh = small ? 320 : 512;
    return {
      vw: Math.min(2048, Math.max(8, Math.round(vh * asp))), vh,
      dw: Math.min(4096, Math.max(8, Math.round(dh * asp))), dh,
    };
  }

  function allocate(asp, keepOldDye) {
    const vp = gl.getParameter(gl.VIEWPORT);
    const { vw, vh, dw, dh } = gridSizes(asp);
    const oldDye = dye;
    const oldBed = bed;
    if (velocity) velocity.dispose();
    if (curl) curl.dispose();
    if (divergence) divergence.dispose();
    if (pressure) pressure.dispose();
    if (probeFboDye) probeFboDye.dispose();
    if (probeFboVel) probeFboVel.dispose();
    if (probeFboBed) probeFboBed.dispose();

    velocity = createDoubleFBO(gl, vw, vh);
    curl = createFBO(gl, vw, vh);
    divergence = createFBO(gl, vw, vh);
    pressure = createDoubleFBO(gl, vw, vh);
    dye = createDoubleFBO(gl, dw, dh);
    bed = createDoubleFBO(gl, dw, dh);
    dyeSizeArr = [dye.w, dye.h];

    // preserve the picture by stretching the old dye into the new target
    if (oldDye) {
      if (keepOldDye) {
        gl.disable(gl.BLEND);
        progCopy.use();
        tex(progCopy, 'uSrc', oldDye.read.tex, 0);
        dye.read.bind();
        drawFullscreen(gl);
        gl.bindFramebuffer(gl.FRAMEBUFFER, null);
      }
      oldDye.dispose();
    }
    // the bed is stretched exactly like the dye
    if (oldBed) {
      if (keepOldDye) {
        gl.disable(gl.BLEND);
        progCopy.use();
        tex(progCopy, 'uSrc', oldBed.read.tex, 0);
        bed.read.bind();
        drawFullscreen(gl);
        gl.bindFramebuffer(gl.FRAMEBUFFER, null);
      }
      oldBed.dispose();
    }

    // probe targets
    probeData.w = 32;
    probeData.h = Math.max(1, Math.round(32 / asp));
    probeFboDye = createFBO(gl, probeData.w, probeData.h, { float: false });
    probeFboVel = createFBO(gl, probeData.w, probeData.h, { float: false });
    probeFboBed = createFBO(gl, probeData.w, probeData.h, { float: false });
    probeBed = new Uint8Array(probeData.w * probeData.h * 4);
    probeData.dye = new Uint8Array(probeData.w * probeData.h * 4);
    probeData.vel = new Uint8Array(probeData.w * probeData.h * 4);
    lastProbeFrame = -1000;

    gl.viewport(vp[0], vp[1], vp[2], vp[3]);
  }

  allocate(curAspect, false);

  // --- passes ---
  function advect(target, source, dt, dissipation, walls) {
    progAdvect.use();
    tex(progAdvect, 'uVelocity', velocity.read.tex, 0);
    tex(progAdvect, 'uSource', source.read.tex, 1);
    f1(progAdvect, 'uDt', dt);
    f1(progAdvect, 'uDissipation', dissipation);
    i1(progAdvect, 'uManual', manual ? 1 : 0);
    i1(progAdvect, 'uWalls', walls ? 1 : 0);
    target.write.bind();
    drawFullscreen(gl);
    target.swap();
  }

  function flushSplats() {
    for (let i = 0; i < splatQueue.length; i++) {
      const s = splatQueue[i];
      if (s.vel) {
        progSplatVel.use();
        tex(progSplatVel, 'uTarget', velocity.read.tex, 0);
        f2(progSplatVel, 'uPoint', s.x, s.y);
        f2(progSplatVel, 'uValue', s.vx * params.splatForce, s.vy * params.splatForce);
        f1(progSplatVel, 'uRadius', s.r);
        f1(progSplatVel, 'uAspect', curAspect);
        velocity.write.bind();
        drawFullscreen(gl);
        velocity.swap();
      }
      if (s.dye) {
        progSplatDye.use();
        tex(progSplatDye, 'uTarget', dye.read.tex, 0);
        f2(progSplatDye, 'uPoint', s.x, s.y);
        f3(progSplatDye, 'uValue', s.a, s.b, s.c);
        f1(progSplatDye, 'uRadius', s.r);
        f1(progSplatDye, 'uAspect', curAspect);
        dye.write.bind();
        drawFullscreen(gl);
        dye.swap();
      }
    }
    splatQueue.length = 0;
  }

  function flushWells(dt) {
    for (let i = 0; i < wellQueue.length; i++) {
      const w = wellQueue[i];
      progWell.use();
      tex(progWell, 'uTarget', velocity.read.tex, 0);
      f2(progWell, 'uPoint', w.x, w.y);
      f1(progWell, 'uStrength', w.strength * dt);
      f1(progWell, 'uRadius', w.radius);
      f1(progWell, 'uAspect', curAspect);
      f1(progWell, 'uSwirl', params.wellSwirl);
      velocity.write.bind();
      drawFullscreen(gl);
      velocity.swap();
    }
    wellQueue.length = 0;
  }

  function runReaction(dt) {
    const ts = dt * params.timeScale;
    if (ts <= 0) return;
    // diffusion in cell^2/s for the dye grid (cells are square: 1/dye.h of the height)
    const dCell = params.diffusion * dye.h * dye.h;
    // explicit-Euler stability: D*dt <= ~0.25 (9-point stencil), reaction rates*dt << 1
    const need = Math.max(ts * dCell / 0.25, ts / 0.05);
    const n = Math.max(1, Math.min(Math.max(1, params.maxSubsteps | 0), Math.ceil(need)));
    const dsub = ts / n;
    const dEff = Math.min(dCell, 0.25 / dsub); // unconditionally stable even if capped
    progReact.use();
    f1(progReact, 'uDt', dsub);
    f1(progReact, 'uGrowth', params.growth);
    f1(progReact, 'uPred', params.predation);
    f1(progReact, 'uDecay', params.decay);
    f1(progReact, 'uDiff', dEff);
    f1(progReact, 'uChi', chi);
    f1(progReact, 'uAllee', Math.max(1e-4, params.allee));
    f1(progReact, 'uFade', params.voidFade);
    f1(progReact, 'uStarve', params.starve);
    f1(progReact, 'uPureLo', params.pureLo);
    f1(progReact, 'uPureHi', params.pureHi);
    f1(progReact, 'uFloor', params.extinctionFloor);
    f1(progReact, 'uBedMax', params.bedMax);
    f1(progReact, 'uBedFert', params.bedFertility);
    tex(progReact, 'uBed', bed.read.tex, 1); // the bed is constant across substeps
    for (let i = 0; i < n; i++) {
      tex(progReact, 'uDye', dye.read.tex, 0);
      dye.write.bind();
      drawFullscreen(gl);
      dye.swap();
    }
  }

  // Dye += scoured silt, then the bed update. Both read the same pre-update bed and velocity.
  function runBed(dt) {
    const lo = params.bedErodeLo;
    const hi = Math.max(params.bedErodeHi, lo + 1e-4);
    const setScour = (p) => {
      f1(p, 'uAspect', curAspect);
      f1(p, 'uBedErode', params.bedErode);
      f1(p, 'uBedErodeLo', lo);
      f1(p, 'uBedErodeHi', hi);
      f1(p, 'uDt', dt);
    };

    progLift.use();
    tex(progLift, 'uDye', dye.read.tex, 0);
    tex(progLift, 'uBed', bed.read.tex, 1);
    tex(progLift, 'uVelocity', velocity.read.tex, 2);
    setScour(progLift);
    f1(progLift, 'uLift', params.bedLift);
    dye.write.bind();
    drawFullscreen(gl);
    dye.swap();

    progBed.use();
    tex(progBed, 'uDye', dye.read.tex, 0); // post-lift dye: what the reaction is about to act on
    tex(progBed, 'uBed', bed.read.tex, 1);
    tex(progBed, 'uVelocity', velocity.read.tex, 2);
    setScour(progBed);
    f1(progBed, 'uTs', dt * params.timeScale);
    f1(progBed, 'uDeposit', Math.max(0, params.bedDeposit));
    f1(progBed, 'uDecay', params.decay);
    f1(progBed, 'uStarve', params.starve);
    f1(progBed, 'uFade', params.voidFade);
    f1(progBed, 'uAllee', Math.max(1e-4, params.allee));
    f1(progBed, 'uPureLo', params.pureLo);
    f1(progBed, 'uPureHi', params.pureHi);
    f1(progBed, 'uBedMax', params.bedMax);
    f1(progBed, 'uBedFert', params.bedFertility);
    f1(progBed, 'uSettle', Math.max(0, params.bedSettle) + scourRate);
    f1(progBed, 'uSmoothK', Math.min(Math.max(0, params.bedSmooth) * dt, 0.2));
    f1(progBed, 'uFadeShare', params.bedFadeShare);
    f1(progBed, 'uSeed', (frame * 0.618034) % 97);
    bed.write.bind();
    drawFullscreen(gl);
    bed.swap();
  }

  function runProbe() {
    const vp = gl.getParameter(gl.VIEWPORT);
    gl.disable(gl.BLEND);
    progProbe.use();
    const { w, h } = probeData;
    f2(progProbe, 'uFoot', 1 / w, 1 / h);
    f1(progProbe, 'uScale', params.probeVelScale);

    i1(progProbe, 'uMode', 0);
    tex(progProbe, 'uSrc', dye.read.tex, 0);
    probeFboDye.bind();
    drawFullscreen(gl);
    gl.readPixels(0, 0, w, h, gl.RGBA, gl.UNSIGNED_BYTE, probeData.dye);

    i1(progProbe, 'uMode', 1);
    tex(progProbe, 'uSrc', velocity.read.tex, 0);
    probeFboVel.bind();
    drawFullscreen(gl);
    gl.readPixels(0, 0, w, h, gl.RGBA, gl.UNSIGNED_BYTE, probeData.vel);

    i1(progProbe, 'uMode', 0);
    tex(progProbe, 'uSrc', bed.read.tex, 0);
    probeFboBed.bind();
    drawFullscreen(gl);
    gl.readPixels(0, 0, w, h, gl.RGBA, gl.UNSIGNED_BYTE, probeBed);

    gl.bindFramebuffer(gl.FRAMEBUFFER, null);
    gl.viewport(vp[0], vp[1], vp[2], vp[3]);

    // CPU statistics
    const n = w * h;
    const d = probeData.dye, v = probeData.vel;
    let sa = 0, sb = 0, sc = 0, en = 0;
    const scale = params.probeVelScale || 1;
    for (let i = 0; i < n; i++) {
      const o = i * 4;
      sa += d[o]; sb += d[o + 1]; sc += d[o + 2];
      let dx = v[o] - 127.5, dy = v[o + 1] - 127.5;
      if (Math.abs(dx) < 1) dx = 0; // 128 is "zero"; ignore the half-step offset
      if (Math.abs(dy) < 1) dy = 0;
      en += Math.hypot(dx, dy) / 127.5 / scale;
    }
    const total = sa + sb + sc;
    probeData.density = Math.min(1, total / 255 / n);
    if (probeData.density < 1e-3) {
      probeData.balance[0] = probeData.balance[1] = probeData.balance[2] = 1 / 3;
    } else {
      probeData.balance[0] = sa / total;
      probeData.balance[1] = sb / total;
      probeData.balance[2] = sc / total;
    }
    probeData.energy = en / n;

    // mean bed height: the three species channels each clamp at 1, so this is h = r+g+b in 0..1
    const bb = probeBed;
    let sh = 0;
    for (let i = 0; i < n; i++) { const o = i * 4; sh += bb[o] + bb[o + 1] + bb[o + 2]; }
    probeData.sediment = Math.min(1, sh / 255 / n);
  }

  // --- public API ---
  const sim = {
    params,

    get dyeTex() { return dye.read.tex; },
    get velocityTex() { return velocity.read.tex; },
    get dyeSize() { return dyeSizeArr; },
    get bedTex() { return bed.read.tex; },
    get bedSize() { return dyeSizeArr; }, // the bed shares the dye grid

    /**
     * Reallocate for a new canvas aspect (no-op if it changed by <1%). Dye is stretched into the
     * new target; velocity and pressure reset.
     * @param {number} asp width/height
     */
    resize(asp) {
      if (!(asp > 0)) return;
      if (Math.abs(asp / curAspect - 1) < 0.01) return;
      curAspect = asp;
      splatQueue.length = 0;
      wellQueue.length = 0;
      allocate(asp, true);
    },

    /**
     * Queue a force + dye splat, applied in the next step().
     * @param {number} x UV x
     * @param {number} y UV y (up)
     * @param {number} vx velocity UV/s
     * @param {number} vy velocity UV/s
     * @param {number[]} species [a,b,c] weights
     * @param {number} radius fraction of screen height (gaussian scale)
     * @param {number} amount dye strength 0..1
     */
    splat(x, y, vx, vy, species, radius, amount) {
      const r = Math.max(1e-3, radius || 0.05);
      const sp = species || [0, 0, 0];
      const amt = amount == null ? 1 : amount;
      const a = (sp[0] || 0) * amt, b = (sp[1] || 0) * amt, c = (sp[2] || 0) * amt;
      const hasVel = Math.abs(vx) + Math.abs(vy) > 1e-6;
      const hasDye = a + b + c > 1e-6;
      if (!hasVel && !hasDye) return;
      if (splatQueue.length >= MAX_QUEUE) splatQueue.shift();
      splatQueue.push({ x, y, vx, vy, r, a, b, c, vel: hasVel, dye: hasDye });
    },

    /**
     * Radial acceleration toward (x,y) when strength > 0, away when < 0, applied next step().
     * strength is an acceleration in UV/s^2 (the pull gains strength*dt of speed per step at the centre).
     * @param {number} x
     * @param {number} y
     * @param {number} strength
     * @param {number} radius fraction of height
     */
    well(x, y, strength, radius) {
      if (!strength) return;
      if (wellQueue.length >= 32) wellQueue.shift();
      wellQueue.push({ x, y, strength, radius: Math.max(1e-3, radius || 0.15) });
    },

    /**
     * Advance fluid + reaction one frame.
     * @param {number} dt seconds
     */
    step(dt) {
      dt = Math.min(Math.max(dt || 0, 0), 1 / 15);
      frame++;
      const vp = gl.getParameter(gl.VIEWPORT);
      gl.disable(gl.BLEND);
      gl.disable(gl.DEPTH_TEST);
      gl.disable(gl.SCISSOR_TEST);

      // smooth chirality so flipping the cycle doesn't pop
      const target = params.chirality >= 0 ? 1 : -1;
      if (params.chiRate > 0) chi += (target - chi) * (1 - Math.exp(-dt * params.chiRate));
      else chi = target;

      flushSplats();
      flushWells(dt);

      if (dt > 0) {
        // curl
        progCurl.use();
        tex(progCurl, 'uVelocity', velocity.read.tex, 0);
        f1(progCurl, 'uAspect', curAspect);
        curl.bind();
        drawFullscreen(gl);

        // vorticity confinement + front force
        progVort.use();
        tex(progVort, 'uVelocity', velocity.read.tex, 0);
        tex(progVort, 'uCurl', curl.tex, 1);
        tex(progVort, 'uDye', dye.read.tex, 2);
        tex(progVort, 'uBed', bed.read.tex, 3);
        i1(progVort, 'uManual', manual ? 1 : 0);
        f1(progVort, 'uBedSlope', params.bedSlope);
        f1(progVort, 'uBedDeflect', params.bedDeflect);
        f1(progVort, 'uBedDrag', params.bedDrag);
        f1(progVort, 'uDt', dt);
        f1(progVort, 'uVorticity', params.vorticity);
        f1(progVort, 'uFrontForce', params.frontForce);
        f1(progVort, 'uChi', chi);
        f1(progVort, 'uAspect', curAspect);
        f1(progVort, 'uMaxVel', params.maxVelocity);
        velocity.write.bind();
        drawFullscreen(gl);
        velocity.swap();

        // divergence
        progDiv.use();
        tex(progDiv, 'uVelocity', velocity.read.tex, 0);
        f1(progDiv, 'uAspect', curAspect);
        divergence.bind();
        drawFullscreen(gl);

        // pressure (Jacobi)
        progPress.use();
        tex(progPress, 'uDivergence', divergence.tex, 1);
        const iters = Math.max(1, params.pressureIterations | 0);
        for (let i = 0; i < iters; i++) {
          tex(progPress, 'uPressure', pressure.read.tex, 0);
          f1(progPress, 'uScale', i === 0 ? params.pressureDecay : 1);
          pressure.write.bind();
          drawFullscreen(gl);
          pressure.swap();
        }

        // gradient subtract
        progGrad.use();
        tex(progGrad, 'uPressure', pressure.read.tex, 0);
        tex(progGrad, 'uVelocity', velocity.read.tex, 1);
        f1(progGrad, 'uAspect', curAspect);
        velocity.write.bind();
        drawFullscreen(gl);
        velocity.swap();

        // advect velocity (with dissipation), then dye (with optional clear decay)
        advect(velocity, velocity, dt, Math.exp(-params.velocityDissipation * dt), true);
        advect(dye, dye, dt, clearRate > 0 ? Math.exp(-clearRate * dt) : 1, false);

        // sediment: lift scoured silt into the dye, update the bed, then react
        runBed(dt);

        // reaction + diffusion
        runReaction(dt);
      }

      gl.bindFramebuffer(gl.FRAMEBUFFER, null);
      gl.viewport(vp[0], vp[1], vp[2], vp[3]);
    },

    /**
     * Low-res CPU readback of dye + velocity with summary stats. Refreshes at most every 6 frames;
     * always returns the same cached object.
     */
    probe() {
      if (frame - lastProbeFrame >= PROBE_INTERVAL) {
        lastProbeFrame = frame;
        runProbe();
      }
      return probeData;
    },

    /**
     * Begin (rate > 0) or end (rate = 0) a gentle dissolve: dye decays extra at `rate` per second.
     * @param {number} rate
     */
    clear(rate) {
      clearRate = Math.max(0, rate || 0);
    },

    /**
     * Begin (rate > 0) or end (rate = 0) scouring the bed: it decays extra at `rate` per second.
     * @param {number} rate
     */
    scour(rate) {
      scourRate = Math.max(0, rate || 0);
    },

    /**
     * Low-res CPU snapshot of ink + floor, area-averaged. Fresh arrays every call.
     * Encoding per rgb byte: round(255 * sqrt(clamp(v / 1.5, 0, 1))); alpha 255; row 0 = bottom.
     * @param {number} [width=160] snapshot width in texels (1..512); height follows the aspect
     * @returns {{w:number,h:number,dye:Uint8Array,bed:Uint8Array}}
     */
    capture(width = 160) {
      const w = Math.min(512, Math.max(1, Math.round(Number(width)) || 160));
      const h = Math.min(512, Math.max(1, Math.round(w / curAspect)));
      const key = w + 'x' + h;
      let cap = captureCache.get(key);
      if (!cap) {
        if (captureCache.size >= 6) {
          for (const c of captureCache.values()) { c.dye.dispose(); c.bed.dispose(); }
          captureCache.clear();
        }
        cap = { dye: createFBO(gl, w, h, { float: false }), bed: createFBO(gl, w, h, { float: false }) };
        captureCache.set(key, cap);
      }
      const vp = gl.getParameter(gl.VIEWPORT);
      gl.disable(gl.BLEND);
      progCapture.use();
      i1(progCapture, 'uEncode', 1);
      i1(progCapture, 'uManual', manual ? 1 : 0);
      f2(progCapture, 'uFoot', 1 / w, 1 / h);
      f2(progCapture, 'uTaps', tapsFor(dye.w, w), tapsFor(dye.h, h));
      const out = { w, h, dye: new Uint8Array(w * h * 4), bed: new Uint8Array(w * h * 4) };
      tex(progCapture, 'uSrc', dye.read.tex, 0);
      cap.dye.bind();
      drawFullscreen(gl);
      gl.readPixels(0, 0, w, h, gl.RGBA, gl.UNSIGNED_BYTE, out.dye);
      tex(progCapture, 'uSrc', bed.read.tex, 0);
      cap.bed.bind();
      drawFullscreen(gl);
      gl.readPixels(0, 0, w, h, gl.RGBA, gl.UNSIGNED_BYTE, out.bed);
      gl.bindFramebuffer(gl.FRAMEBUFFER, null);
      gl.viewport(vp[0], vp[1], vp[2], vp[3]);
      return out;
    },

    /**
     * Write a capture() snapshot back into the ink and/or floor. Velocity and pressure are untouched.
     * blend >= 1 replaces the field with the bilinearly upsampled snapshot; blend < 1 nudges only
     * the low frequencies: x = max(0, x + blend * (S - L)), L = local field area-averaged to the
     * snapshot's resolution. Invalid input is ignored silently.
     * @param {{w:number,h:number,dye:Uint8Array,bed:Uint8Array}} snap
     * @param {{blend?:number,dye?:boolean,bed?:boolean}} [opts]
     */
    restore(snap, opts) {
      if (!snap || typeof snap !== 'object') return;
      const o = opts || {};
      const doDye = o.dye !== false, doBed = o.bed !== false;
      let blend = o.blend === undefined ? 1 : Number(o.blend);
      if (Number.isNaN(blend)) blend = 1;
      const { w, h } = snap;
      if (!Number.isInteger(w) || !Number.isInteger(h) || w < 1 || h < 1 || w > 512 || h > 512) return;
      const n = w * h * 4;
      const okArr = (a) => !!a && ArrayBuffer.isView(a) && a.BYTES_PER_ELEMENT === 1 && a.length === n;
      if ((doDye && !okArr(snap.dye)) || (doBed && !okArr(snap.bed))) return;
      if (blend <= 0 || (!doDye && !doBed)) return;
      const nudge = blend < 1;

      const vp = gl.getParameter(gl.VIEWPORT);
      const pa = gl.getParameter(gl.UNPACK_ALIGNMENT);
      const pf = gl.getParameter(gl.UNPACK_FLIP_Y_WEBGL);
      const pp = gl.getParameter(gl.UNPACK_PREMULTIPLY_ALPHA_WEBGL);
      gl.disable(gl.BLEND);
      gl.pixelStorei(gl.UNPACK_ALIGNMENT, 1);
      gl.pixelStorei(gl.UNPACK_FLIP_Y_WEBGL, false); // row 0 = bottom already matches GL
      gl.pixelStorei(gl.UNPACK_PREMULTIPLY_ALPHA_WEBGL, false);

      if (nudge && (!lowFbo || lowFbo.w !== w || lowFbo.h !== h)) {
        if (lowFbo) lowFbo.dispose();
        lowFbo = createFBO(gl, w, h); // float: the low-pass must not be quantised
      }

      const field = (target, bytes) => {
        const snapTex = gl.createTexture();
        gl.activeTexture(gl.TEXTURE0);
        gl.bindTexture(gl.TEXTURE_2D, snapTex);
        gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.LINEAR);
        gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.LINEAR);
        gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
        gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
        gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA8, w, h, 0, gl.RGBA, gl.UNSIGNED_BYTE, bytes);

        if (nudge) {
          // L: the local field averaged down to the snapshot grid, exactly as capture does (no encode)
          progCapture.use();
          i1(progCapture, 'uEncode', 0);
          i1(progCapture, 'uManual', manual ? 1 : 0);
          f2(progCapture, 'uFoot', 1 / w, 1 / h);
          f2(progCapture, 'uTaps', tapsFor(target.w, w), tapsFor(target.h, h));
          tex(progCapture, 'uSrc', target.read.tex, 0);
          lowFbo.bind();
          drawFullscreen(gl);
        }

        progRestore.use();
        tex(progRestore, 'uSnap', snapTex, 0);
        tex(progRestore, 'uLocal', nudge ? lowFbo.tex : snapTex, 1);
        tex(progRestore, 'uField', target.read.tex, 2);
        f1(progRestore, 'uBlend', Math.min(blend, 1));
        i1(progRestore, 'uUseBlend', nudge ? 1 : 0);
        i1(progRestore, 'uManualL', caps.linearFloat ? 0 : 1);
        target.write.bind();
        drawFullscreen(gl);
        target.swap();
        gl.deleteTexture(snapTex);
      };
      if (doDye) field(dye, snap.dye);
      if (doBed) field(bed, snap.bed);

      gl.pixelStorei(gl.UNPACK_ALIGNMENT, pa);
      gl.pixelStorei(gl.UNPACK_FLIP_Y_WEBGL, pf);
      gl.pixelStorei(gl.UNPACK_PREMULTIPLY_ALPHA_WEBGL, pp);
      gl.bindFramebuffer(gl.FRAMEBUFFER, null);
      gl.viewport(vp[0], vp[1], vp[2], vp[3]);
      gl.disable(gl.BLEND);
      lastProbeFrame = -1000; // let the next probe() see the new picture
    },

    /** Instantly wipe dye, bed and velocity. */
    reset() {
      const vp = gl.getParameter(gl.VIEWPORT);
      gl.clearColor(0, 0, 0, 0);
      for (const t of [dye.read, dye.write, bed.read, bed.write, velocity.read, velocity.write,
        pressure.read, pressure.write]) {
        gl.bindFramebuffer(gl.FRAMEBUFFER, t.fbo);
        gl.clear(gl.COLOR_BUFFER_BIT);
      }
      gl.bindFramebuffer(gl.FRAMEBUFFER, null);
      gl.viewport(vp[0], vp[1], vp[2], vp[3]);
      splatQueue.length = 0;
      wellQueue.length = 0;
    },
  };

  return sim;
}
