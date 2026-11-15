// Display pipeline for Eddy: species dye -> OKLab ink on a dark void -> HDR scene
// -> overlay (motes) -> bloom -> filmic tonemap + sRGB + grain.
import { FULLSCREEN_VS, createProgram, createFBO, drawFullscreen, bindTex } from './gl.js';

const HEAD = `#version 300 es
precision highp float;
precision highp sampler2D;
in vec2 vUv;
out vec4 fragColor;
`;

/* ------------------------------------------------------------------ scene */

const SCENE_FS = HEAD + `
uniform sampler2D uDye;
uniform sampler2D uVel;
uniform vec2 uTexel;
uniform float uAspect;
uniform float uTime;
uniform float uChir;
uniform float uTide;
uniform vec3 uLabA;
uniform vec3 uLabB;
uniform vec3 uLabC;
uniform vec3 uLabP;
uniform vec3 uDeep;
uniform vec3 uPearl;
uniform vec3 uAccent;

vec3 oklabToLinear(vec3 c) {
  float l_ = c.x + 0.3963377774 * c.y + 0.2158037573 * c.z;
  float m_ = c.x - 0.1055613458 * c.y - 0.0638541728 * c.z;
  float s_ = c.x - 0.0894841775 * c.y - 1.2914855480 * c.z;
  float l = l_ * l_ * l_;
  float m = m_ * m_ * m_;
  float s = s_ * s_ * s_;
  return max(vec3(
     4.0767416621 * l - 3.3077115913 * m + 0.2309699292 * s,
    -1.2684380046 * l + 2.6097574011 * m - 0.3413193965 * s,
    -0.0041960863 * l - 0.7034186147 * m + 1.7076147010 * s), vec3(0.0));
}

float hash21(vec2 p) {
  p = fract(p * vec2(123.34, 456.21));
  p += dot(p, p + 45.32);
  return fract(p.x * p.y);
}

float vnoise(vec2 p) {
  vec2 i = floor(p);
  vec2 f = fract(p);
  f = f * f * (3.0 - 2.0 * f);
  float a = hash21(i);
  float b = hash21(i + vec2(1.0, 0.0));
  float c = hash21(i + vec2(0.0, 1.0));
  float d = hash21(i + vec2(1.0, 1.0));
  return mix(mix(a, b, f.x), mix(c, d, f.x), f.y);
}

vec3 comp(vec3 s) {
  return s / max(s.r + s.g + s.b, 0.02);
}

void main() {
  vec2 uv = vUv;
  vec3 s = max(texture(uDye, uv).rgb, vec3(0.0));
  float rho = s.r + s.g + s.b;
  vec3 w = s / max(rho, 1e-4);

  // neighbours for height / composition gradients
  vec2 o = uTexel * 1.25;
  vec3 sR = max(texture(uDye, uv + vec2(o.x, 0.0)).rgb, vec3(0.0));
  vec3 sL = max(texture(uDye, uv - vec2(o.x, 0.0)).rgb, vec3(0.0));
  vec3 sT = max(texture(uDye, uv + vec2(0.0, o.y)).rgb, vec3(0.0));
  vec3 sB = max(texture(uDye, uv - vec2(0.0, o.y)).rgb, vec3(0.0));
  float rR = sR.r + sR.g + sR.b;
  float rL = sL.r + sL.g + sL.b;
  float rT = sT.r + sT.g + sT.b;
  float rB = sB.r + sB.g + sB.b;

  // ---- tide ripple (expanding ring while uTide decays 1 -> 0)
  vec2 pc = (uv - 0.5) * vec2(uAspect, 1.0);
  float rad = length(pc);
  float ringPos = (1.0 - uTide) * 1.7;
  float ringD = (rad - ringPos) * 3.2;
  float ring = exp(-ringD * ringD) * uTide;

  // ---- ink colour: mix in OKLab, restore a little chroma lost to opposing hues
  vec3 lab = w.x * uLabA + w.y * uLabB + w.z * uLabC;
  float chExpect = w.x * length(uLabA.yz) + w.y * length(uLabB.yz) + w.z * length(uLabC.yz);
  float chGot = length(lab.yz);
  lab.yz *= mix(1.0, clamp(chExpect / max(chGot, 1e-3), 1.0, 1.7), 0.6);

  // composition fronts + density rims: these are what stay lit
  vec3 wR = comp(sR);
  vec3 wL = comp(sL);
  vec3 wT = comp(sT);
  vec3 wB = comp(sB);
  float gm = length(wR - wL) + length(wT - wB);
  float rhoMin = min(min(rR, rL), min(rT, rB));
  float front = smoothstep(0.05, 0.9, gm) * smoothstep(0.06, 0.35, min(rho, rhoMin + 0.1));
  float rim = smoothstep(0.02, 0.45, length(vec2(rR - rL, rT - rB)));

  // pearl: the rare jewel where all three species balance (spiral cores)
  float bal = clamp(27.0 * w.x * w.y * w.z, 0.0, 1.0);
  float pearlK = pow(bal, 4.0) * smoothstep(0.45, 0.95, rho);
  lab = mix(lab, uLabP, pearlK * 0.8);

  // soft filmic density -> opacity
  float alpha = 1.0 - exp(-rho * 2.3);
  alpha = alpha * alpha * (3.0 - 2.0 * alpha) * 0.35 + alpha * 0.65;

  // depth: thick ink sinks into saturated shadow; fronts, rims and pearls stay luminous
  float body = smoothstep(0.25, 0.95, rho);
  float lit = clamp(front * 0.95 + rim * 0.55 + pearlK, 0.0, 1.0);
  lab.x *= mix(0.66, 1.0, alpha) * mix(1.0, 0.50, body * (1.0 - lit));
  lab.yz *= 1.0 + 0.30 * body * (1.0 - lit);

  // tide: momentary desaturate + brighten along the ring, faint overall lift
  lab.yz *= 1.0 - 0.65 * ring - 0.12 * uTide;
  lab.x += 0.10 * ring + 0.015 * uTide;

  vec3 ink = oklabToLinear(lab);

  // ---- wet-ink lighting
  float hR = 1.0 - exp(-rR * 1.6);
  float hL = 1.0 - exp(-rL * 1.6);
  float hT = 1.0 - exp(-rT * 1.6);
  float hB = 1.0 - exp(-rB * 1.6);
  vec3 n = normalize(vec3(-(hR - hL) * 3.2, -(hT - hB) * 3.2, 1.0));
  vec3 Ld = normalize(vec3(-0.45, 0.65, 0.62));
  float ndl = dot(n, Ld);
  ink *= 1.0 + 0.55 * (ndl - Ld.z);
  vec3 H = normalize(Ld + vec3(0.0, 0.0, 1.0));
  float spec = pow(max(dot(n, H), 0.0), 70.0) * 0.22;
  spec *= smoothstep(0.02, 0.25, rho);
  vec3 specCol = mix(vec3(1.0), uPearl, 0.5);

  // ---- thin-film iridescence on species fronts
  vec2 vel = texture(uVel, uv).rg;
  vec2 vd = vel / (length(vel) + 0.02);
  float phase = gm * 1.4 + uTime * 0.03 + 0.22 * (vd.x * 0.8 + vd.y * 0.6) + rho * 0.15;
  phase *= uChir;
  vec3 film = 0.5 + 0.5 * cos(6.28318 * (phase + vec3(0.0, 0.33, 0.67)));
  float lum = dot(ink, vec3(0.2126, 0.7152, 0.0722));
  vec3 iri = film * (0.05 + 0.5 * lum) * front * 0.55;

  // ---- the void
  float vig = smoothstep(0.25, 1.05, rad);
  float nz = vnoise(pc * 1.3 + vec2(uTime * 0.006, -uTime * 0.004));
  float nz2 = vnoise(pc * 3.1 - vec2(uTime * 0.01, 0.0));
  float cloud = 0.6 * nz + 0.4 * nz2;
  vec3 bg = uDeep * (1.0 - 0.5 * vig) * (0.75 + 0.6 * cloud);
  bg += uDeep * 0.7 * exp(-rad * rad * 2.8);
  bg += mix(uPearl, uAccent, cloud) * 0.0012 * (1.0 - vig) * (0.4 + cloud);

  vec3 col = mix(bg, ink, alpha);
  col += iri * (0.4 + 0.6 * alpha);
  col += specCol * spec * (0.3 + 0.7 * alpha);
  col += uPearl * ink * pearlK * 0.22;   // pearls glow
  col += ink * front * alpha * 0.45;      // living fronts are faintly emissive
  col += uPearl * 0.018 * uTide * (0.5 + 0.5 * sin(rad * 24.0 - uTime * 5.0)) * (0.3 + ring);
  col += uPearl * ring * 0.05;

  fragColor = vec4(col, 1.0);
}`;

/* ------------------------------------------------------------------ bloom */

const DOWN_FS = HEAD + `
uniform sampler2D uTex;
uniform vec2 uTexel; // texel of the SOURCE
void main() {
  vec2 p = uTexel;
  vec3 a = texture(uTex, vUv + p * vec2(-2.0,  2.0)).rgb;
  vec3 b = texture(uTex, vUv + p * vec2( 0.0,  2.0)).rgb;
  vec3 c = texture(uTex, vUv + p * vec2( 2.0,  2.0)).rgb;
  vec3 d = texture(uTex, vUv + p * vec2(-2.0,  0.0)).rgb;
  vec3 e = texture(uTex, vUv).rgb;
  vec3 f = texture(uTex, vUv + p * vec2( 2.0,  0.0)).rgb;
  vec3 g = texture(uTex, vUv + p * vec2(-2.0, -2.0)).rgb;
  vec3 h = texture(uTex, vUv + p * vec2( 0.0, -2.0)).rgb;
  vec3 i = texture(uTex, vUv + p * vec2( 2.0, -2.0)).rgb;
  vec3 j = texture(uTex, vUv + p * vec2(-1.0,  1.0)).rgb;
  vec3 k = texture(uTex, vUv + p * vec2( 1.0,  1.0)).rgb;
  vec3 l = texture(uTex, vUv + p * vec2(-1.0, -1.0)).rgb;
  vec3 m = texture(uTex, vUv + p * vec2( 1.0, -1.0)).rgb;
  vec3 r = e * 0.125 + (a + c + g + i) * 0.03125 + (b + d + f + h) * 0.0625 + (j + k + l + m) * 0.125;
  fragColor = vec4(r, 1.0);
}`;

// out = base + weight * tent(low)
const UP_FS = HEAD + `
uniform sampler2D uBase;
uniform sampler2D uLow;
uniform vec2 uTexel; // texel of the LOW (source) level
uniform float uWeight;
void main() {
  vec2 p = uTexel;
  vec3 s = texture(uLow, vUv + p * vec2(-1.0,  1.0)).rgb
         + texture(uLow, vUv + p * vec2( 1.0,  1.0)).rgb
         + texture(uLow, vUv + p * vec2(-1.0, -1.0)).rgb
         + texture(uLow, vUv + p * vec2( 1.0, -1.0)).rgb;
  s += 2.0 * (texture(uLow, vUv + p * vec2(-1.0, 0.0)).rgb
            + texture(uLow, vUv + p * vec2( 1.0, 0.0)).rgb
            + texture(uLow, vUv + p * vec2(0.0,  1.0)).rgb
            + texture(uLow, vUv + p * vec2(0.0, -1.0)).rgb);
  s += 4.0 * texture(uLow, vUv).rgb;
  s *= 1.0 / 16.0;
  fragColor = vec4(texture(uBase, vUv).rgb + s * uWeight, 1.0);
}`;

/* ------------------------------------------------------------------ final */

const FINAL_FS = HEAD + `
uniform sampler2D uScene;
uniform sampler2D uBloom;
uniform vec2 uTexel;
uniform float uBloomAmt;
uniform float uTime;
uniform float uTide;

float hash12(vec2 p) {
  vec3 p3 = fract(vec3(p.xyx) * 0.1031);
  p3 += dot(p3, p3.yzx + 33.33);
  return fract((p3.x + p3.y) * p3.z);
}

vec3 aces(vec3 x) {
  return clamp((x * (2.51 * x + 0.03)) / (x * (2.43 * x + 0.59) + 0.14), 0.0, 1.0);
}

vec3 toSrgb(vec3 c) {
  c = clamp(c, 0.0, 1.0);
  vec3 lo = c * 12.92;
  vec3 hi = 1.055 * pow(c, vec3(1.0 / 2.4)) - 0.055;
  return mix(lo, hi, step(vec3(0.0031308), c));
}

void main() {
  // very slight chromatic softness: red/blue sampled a hair apart, radially
  vec2 d = (vUv - 0.5);
  vec2 ca = d * 0.0016;
  vec3 sc = vec3(texture(uScene, vUv + ca).r, texture(uScene, vUv).g, texture(uScene, vUv - ca).b);
  vec3 bl = texture(uBloom, vUv).rgb;
  vec3 hdr = sc + bl * uBloomAmt;
  hdr *= 1.0 + 0.1 * uTide;

  // filmic curve that keeps the deep end linear so the void stays tinted, not crushed
  float lum = dot(hdr, vec3(0.2126, 0.7152, 0.0722));
  vec3 tm = mix(hdr, aces(hdr), smoothstep(0.01, 0.30, lum));
  vec3 o = toSrgb(tm);

  // animated triangular-PDF dither + fine grain, a touch stronger in the darks
  vec2 fc = gl_FragCoord.xy;
  float t = floor(uTime * 24.0);
  float n1 = hash12(fc + vec2(t * 17.0, t * 31.0));
  float n2 = hash12(fc.yx * 1.37 + vec2(t * 53.0, t * 11.0) + 7.0);
  float tri = n1 + n2 - 1.0;
  float amp = (1.4 + 1.6 * (1.0 - smoothstep(0.0, 0.25, lum))) / 255.0;
  o += vec3(tri * amp);

  fragColor = vec4(o, 1.0);
}`;

/* ------------------------------------------------------------------ JS */

const MAX_LONG_SIDE = 1920;
const BLOOM_LEVELS = 5;
const UP_WEIGHT = 0.7;
// normalisation for the accumulated chain: 1 + w + w^2 + ...
let BLOOM_NORM = 0;
for (let i = 0, p = 1; i < BLOOM_LEVELS; i++, p *= UP_WEIGHT) BLOOM_NORM += p;
const BLOOM_MIX = 0.30;

// linear sRGB -> OKLab (for feeding the shader)
function linearToOklab(c, out) {
  const r = c[0], g = c[1], b = c[2];
  const l = Math.cbrt(0.4122214708 * r + 0.5363325363 * g + 0.0514459929 * b);
  const m = Math.cbrt(0.2119034982 * r + 0.6806995451 * g + 0.1073969566 * b);
  const s = Math.cbrt(0.0883024619 * r + 0.2817188376 * g + 0.6299787005 * b);
  out[0] = 0.2104542553 * l + 0.7936177850 * m - 0.0040720468 * s;
  out[1] = 1.9779984951 * l - 2.4285922050 * m + 0.4505937099 * s;
  out[2] = 0.0259040371 * l + 0.7827717662 * m - 0.8086757660 * s;
  return out;
}

/**
 * Create the renderer.
 * @param {WebGL2RenderingContext} gl
 */
export function createRenderer(gl) {
  const scene = createProgram(gl, FULLSCREEN_VS, SCENE_FS);
  const down = createProgram(gl, FULLSCREEN_VS, DOWN_FS);
  const up = createProgram(gl, FULLSCREEN_VS, UP_FS);
  const fin = createProgram(gl, FULLSCREEN_VS, FINAL_FS);

  let sceneFbo = null;
  let downs = [];
  let ups = [];
  let outW = 0, outH = 0;
  const lab = [0, 0, 0];

  function free() {
    if (sceneFbo) sceneFbo.dispose();
    for (const f of downs) f.dispose();
    for (const f of ups) f.dispose();
    sceneFbo = null; downs = []; ups = [];
  }

  function resize(pw, ph) {
    pw = Math.max(1, Math.round(pw));
    ph = Math.max(1, Math.round(ph));
    outW = pw; outH = ph;
    const k = Math.min(1, MAX_LONG_SIDE / Math.max(pw, ph));
    const sw = Math.max(1, Math.round(pw * k));
    const sh = Math.max(1, Math.round(ph * k));
    if (sceneFbo && sceneFbo.w === sw && sceneFbo.h === sh) return;
    free();
    sceneFbo = createFBO(gl, sw, sh);
    let w = sw, h = sh;
    for (let i = 0; i < BLOOM_LEVELS; i++) {
      w = Math.max(2, Math.round(w / 2));
      h = Math.max(2, Math.round(h / 2));
      downs.push(createFBO(gl, w, h));
      ups.push(createFBO(gl, w, h));
    }
  }

  function setLab(loc, rgb) {
    linearToOklab(rgb, lab);
    gl.uniform3f(loc, lab[0], lab[1], lab[2]);
  }

  function render(p) {
    if (!sceneFbo) resize(gl.drawingBufferWidth, gl.drawingBufferHeight);
    const { dyeTex, velocityTex, dyeSize, colors } = p;
    const time = p.time || 0;
    gl.disable(gl.BLEND);
    gl.disable(gl.DEPTH_TEST);

    // 1. scene
    sceneFbo.bind();
    scene.use();
    const u = scene.uniforms;
    bindTex(gl, u.uDye, dyeTex, 0);
    bindTex(gl, u.uVel, velocityTex, 1);
    const dw = dyeSize ? dyeSize[0] : 256;
    const dh = dyeSize ? dyeSize[1] : 256;
    gl.uniform2f(u.uTexel, 1 / dw, 1 / dh);
    gl.uniform1f(u.uAspect, sceneFbo.w / sceneFbo.h);
    gl.uniform1f(u.uTime, time);
    gl.uniform1f(u.uChir, p.chirality < 0 ? -1 : 1);
    gl.uniform1f(u.uTide, p.tide || 0);
    setLab(u.uLabA, colors.a);
    setLab(u.uLabB, colors.b);
    setLab(u.uLabC, colors.c);
    setLab(u.uLabP, colors.pearl);
    gl.uniform3fv(u.uDeep, colors.deep);
    gl.uniform3fv(u.uPearl, colors.pearl);
    gl.uniform3fv(u.uAccent, colors.accent);
    drawFullscreen(gl);

    // 2. overlay (motes) into the HDR scene
    if (typeof p.overlay === 'function') {
      sceneFbo.bind();
      p.overlay();
      gl.disable(gl.BLEND);
    }

    // 3. bloom: down chain, then accumulate upwards
    down.use();
    let src = sceneFbo;
    for (let i = 0; i < BLOOM_LEVELS; i++) {
      downs[i].bind();
      bindTex(gl, down.uniforms.uTex, src.tex, 0);
      gl.uniform2f(down.uniforms.uTexel, src.texel[0], src.texel[1]);
      drawFullscreen(gl);
      src = downs[i];
    }
    up.use();
    let low = downs[BLOOM_LEVELS - 1];
    for (let i = BLOOM_LEVELS - 2; i >= 0; i--) {
      ups[i].bind();
      bindTex(gl, up.uniforms.uBase, downs[i].tex, 0);
      bindTex(gl, up.uniforms.uLow, low.tex, 1);
      gl.uniform2f(up.uniforms.uTexel, low.texel[0], low.texel[1]);
      gl.uniform1f(up.uniforms.uWeight, UP_WEIGHT);
      drawFullscreen(gl);
      low = ups[i];
    }
    const bloomTex = low.tex;

    // 4. final to canvas
    const cw = gl.drawingBufferWidth || outW;
    const ch = gl.drawingBufferHeight || outH;
    gl.bindFramebuffer(gl.FRAMEBUFFER, null);
    gl.viewport(0, 0, cw, ch);
    fin.use();
    const f = fin.uniforms;
    bindTex(gl, f.uScene, sceneFbo.tex, 0);
    bindTex(gl, f.uBloom, bloomTex, 1);
    gl.uniform2f(f.uTexel, 1 / cw, 1 / ch);
    gl.uniform1f(f.uBloomAmt, BLOOM_MIX / BLOOM_NORM * 1.6);
    gl.uniform1f(f.uTime, time);
    gl.uniform1f(f.uTide, p.tide || 0);
    drawFullscreen(gl);

    gl.disable(gl.BLEND);
    gl.bindFramebuffer(gl.FRAMEBUFFER, null);
  }

  return { resize, render };
}
