// Motes: tiny living lights born where the three species balance. They swim the
// currents and link into fleeting constellations. CPU simulation + additive GL draw.

import { createProgram } from './gl.js';

const POINT_VS = `#version 300 es
precision highp float;
layout(location = 0) in vec2 aPos;
layout(location = 1) in float aSize;
layout(location = 2) in float aBright;
uniform float uScale;
out float vBright;
void main() {
  gl_Position = vec4(aPos * 2.0 - 1.0, 0.0, 1.0);
  gl_PointSize = max(aSize * uScale, 2.0);
  vBright = aBright;
}`;

const POINT_FS = `#version 300 es
precision highp float;
in float vBright;
uniform vec3 uColor;
out vec4 fragColor;
void main() {
  vec2 d = (gl_PointCoord - vec2(0.5)) * 2.0;
  float r2 = dot(d, d);
  float edge = 1.0 - smoothstep(0.55, 1.0, r2);
  float core = exp(-r2 * 22.0);
  float halo = exp(-r2 * 4.5) * 0.16;
  float g = (core * 1.7 + halo) * edge;
  vec3 col = mix(uColor, vec3(1.0), core * 0.45);
  fragColor = vec4(col * g * vBright, 1.0);
}`;

const LINE_VS = `#version 300 es
precision highp float;
layout(location = 0) in vec2 aPos;
layout(location = 1) in float aAlpha;
out float vAlpha;
void main() {
  gl_Position = vec4(aPos * 2.0 - 1.0, 0.0, 1.0);
  vAlpha = aAlpha;
}`;

const LINE_FS = `#version 300 es
precision highp float;
in float vAlpha;
uniform vec3 uColor;
out vec4 fragColor;
void main() {
  fragColor = vec4(uColor * vAlpha, 1.0);
}`;

const TAU = Math.PI * 2;
const LINK_DIST = 0.07;
const LINK_KEEP = 1.15;
const MAX_DEG = 3;

function smoothstep(a, b, x) {
  const t = Math.min(1, Math.max(0, (x - a) / (b - a)));
  return t * t * (3 - 2 * t);
}

/**
 * Create the motes layer.
 * @param {WebGL2RenderingContext} gl
 * @param {{max?: number}} [opts]
 */
export function createMotes(gl, { max = 220 } = {}) {
  const N = max;

  // --- state (stable slots) ---
  const alive = new Uint8Array(N);
  const px = new Float32Array(N), py = new Float32Array(N);
  const ang = new Float32Array(N);
  const spd = new Float32Array(N);
  const ph1 = new Float32Array(N), ph2 = new Float32Array(N), twPh = new Float32Array(N);
  const twRate = new Float32Array(N);
  const size = new Float32Array(N);
  const age = new Float32Array(N), life = new Float32Array(N), en = new Float32Array(N);
  const bright = new Float32Array(N);
  const alx = new Float32Array(N), aly = new Float32Array(N), alc = new Float32Array(N);
  const deg = new Uint8Array(N);
  let pairsPrev = new Uint8Array(N * N);
  let pairsCur = new Uint8Array(N * N);

  let clock = 0;
  let birthTimer = 0;
  let birthTokens = 1;
  let linkCool = 0;

  // scratch
  const sd = [0, 0, 0];
  const sv = [0, 0];

  // --- GL resources ---
  const pointProg = createProgram(gl, POINT_VS, POINT_FS);
  const lineProg = createProgram(gl, LINE_VS, LINE_FS);

  const pointData = new Float32Array(N * 4);
  const maxLinks = N * MAX_DEG;
  const lineData = new Float32Array(maxLinks * 2 * 3);
  let nPoints = 0;
  let nLineVerts = 0;

  const pointBuf = gl.createBuffer();
  gl.bindBuffer(gl.ARRAY_BUFFER, pointBuf);
  gl.bufferData(gl.ARRAY_BUFFER, pointData.byteLength, gl.DYNAMIC_DRAW);
  const pointVao = gl.createVertexArray();
  gl.bindVertexArray(pointVao);
  gl.bindBuffer(gl.ARRAY_BUFFER, pointBuf);
  gl.enableVertexAttribArray(0);
  gl.vertexAttribPointer(0, 2, gl.FLOAT, false, 16, 0);
  gl.enableVertexAttribArray(1);
  gl.vertexAttribPointer(1, 1, gl.FLOAT, false, 16, 8);
  gl.enableVertexAttribArray(2);
  gl.vertexAttribPointer(2, 1, gl.FLOAT, false, 16, 12);

  const lineBuf = gl.createBuffer();
  gl.bindBuffer(gl.ARRAY_BUFFER, lineBuf);
  gl.bufferData(gl.ARRAY_BUFFER, lineData.byteLength, gl.DYNAMIC_DRAW);
  const lineVao = gl.createVertexArray();
  gl.bindVertexArray(lineVao);
  gl.bindBuffer(gl.ARRAY_BUFFER, lineBuf);
  gl.enableVertexAttribArray(0);
  gl.vertexAttribPointer(0, 2, gl.FLOAT, false, 12, 0);
  gl.enableVertexAttribArray(1);
  gl.vertexAttribPointer(1, 1, gl.FLOAT, false, 12, 8);
  gl.bindVertexArray(null);
  gl.bindBuffer(gl.ARRAY_BUFFER, null);

  // --- probe sampling ---
  function sampleDye(probe, u, v, out) {
    const w = probe.w, h = probe.h, a = probe.dye;
    let fx = u * w - 0.5, fy = v * h - 0.5;
    fx = Math.min(w - 1, Math.max(0, fx));
    fy = Math.min(h - 1, Math.max(0, fy));
    const x0 = Math.floor(fx), y0 = Math.floor(fy);
    const x1 = Math.min(w - 1, x0 + 1), y1 = Math.min(h - 1, y0 + 1);
    const tx = fx - x0, ty = fy - y0;
    const i00 = (y0 * w + x0) * 4, i10 = (y0 * w + x1) * 4;
    const i01 = (y1 * w + x0) * 4, i11 = (y1 * w + x1) * 4;
    for (let c = 0; c < 3; c++) {
      const top = a[i00 + c] * (1 - tx) + a[i10 + c] * tx;
      const bot = a[i01 + c] * (1 - tx) + a[i11 + c] * tx;
      out[c] = (top * (1 - ty) + bot * ty) / 255;
    }
  }

  function sampleVel(probe, u, v, out, scale) {
    const w = probe.w, h = probe.h, a = probe.vel;
    let fx = u * w - 0.5, fy = v * h - 0.5;
    fx = Math.min(w - 1, Math.max(0, fx));
    fy = Math.min(h - 1, Math.max(0, fy));
    const x0 = Math.floor(fx), y0 = Math.floor(fy);
    const x1 = Math.min(w - 1, x0 + 1), y1 = Math.min(h - 1, y0 + 1);
    const tx = fx - x0, ty = fy - y0;
    const i00 = (y0 * w + x0) * 4, i10 = (y0 * w + x1) * 4;
    const i01 = (y1 * w + x0) * 4, i11 = (y1 * w + x1) * 4;
    for (let c = 0; c < 2; c++) {
      const top = a[i00 + c] * (1 - tx) + a[i10 + c] * tx;
      const bot = a[i01 + c] * (1 - tx) + a[i11 + c] * tx;
      const b = top * (1 - ty) + bot * ty;
      out[c] = (b / 255 * 2 - 1) / scale;
    }
  }

  /** Total-density factor 0..1 from sampled dye. */
  function densityOf(s) {
    return smoothstep(0.25, 0.8, s[0] + s[1] + s[2]);
  }

  function pearlAt(probe, u, v) {
    sampleDye(probe, u, v, sd);
    const sum = sd[0] + sd[1] + sd[2];
    if (sum < 1e-3) return 0;
    const p = 27 * (sd[0] / sum) * (sd[1] / sum) * (sd[2] / sum);
    return p * smoothstep(0.25, 0.8, sum);
  }

  function fieldAt(probe, u, v) {
    sampleDye(probe, u, v, sd);
    const sum = sd[0] + sd[1] + sd[2];
    if (sum < 1e-3) return 0;
    const p = 27 * (sd[0] / sum) * (sd[1] / sum) * (sd[2] / sum);
    const d = smoothstep(0.25, 0.8, sum);
    return p * d * 0.7 + d * 0.3;
  }

  function spawn(x, y) {
    let i = -1;
    for (let k = 0; k < N; k++) if (!alive[k]) { i = k; break; }
    if (i < 0) return -1;
    alive[i] = 1;
    px[i] = x; py[i] = y;
    ang[i] = Math.random() * TAU;
    spd[i] = 0.01 + Math.random() * 0.01;
    ph1[i] = Math.random() * TAU; ph2[i] = Math.random() * TAU;
    twPh[i] = Math.random() * TAU;
    twRate[i] = 0.5 + Math.random() * 1.1;
    size[i] = 0.7 + Math.random() * 0.5;
    age[i] = 0;
    life[i] = 25 + Math.random() * 35;
    en[i] = 1;
    bright[i] = 0;
    motes.count++;
    return i;
  }

  function kill(i) {
    alive[i] = 0;
    motes.count--;
  }

  const motes = {
    count: 0,
    onBirth: null,
    onLink: null,

    /**
     * Advance the motes.
     * @param {number} dt seconds
     * @param {object|null} probe from sim.probe()
     * @param {{aspect:number, pointer:{x:number,y:number,down:boolean,held:boolean}|null}} ctx
     */
    update(dt, probe, ctx = {}) {
      if (!probe || !probe.dye || !probe.vel || !probe.w || !probe.h) return;
      if (!(dt > 0)) return;
      const aspect = ctx.aspect > 0 ? ctx.aspect : 1;
      const pointer = ctx.pointer || null;
      const velScale = probe.velScale || 4;
      clock += dt;

      // --- birth ---
      birthTokens = Math.min(1, birthTokens + dt * 2);
      birthTimer += dt;
      const ramp = 0.35 + 0.65 * smoothstep(15, 90, clock);
      while (birthTimer >= 1 / 6) {
        birthTimer -= 1 / 6;
        if (birthTokens < 1 || motes.count >= N) continue;
        const u = Math.random(), v = Math.random();
        const p = pearlAt(probe, u, v);
        const prob = smoothstep(0.3, 0.8, p) * 0.7 * ramp;
        if (Math.random() < prob) {
          const x = Math.min(0.98, Math.max(0.02, u));
          const y = Math.min(0.98, Math.max(0.02, v));
          if (spawn(x, y) >= 0) {
            birthTokens -= 1;
            if (motes.onBirth) motes.onBirth(x, y);
          }
        }
      }

      // --- motion ---
      const eps = 0.05;
      for (let i = 0; i < N; i++) {
        if (!alive[i]) continue;
        let x = px[i], y = py[i];

        sampleVel(probe, x, y, sv, velScale);
        let vx = sv[0];          // UV/s in x-UV
        let vy = sv[1];          // UV/s in y-UV (height units)

        // wander heading
        ang[i] += (Math.sin(clock * 0.37 + ph1[i]) + Math.sin(clock * 0.91 + ph2[i])) * 0.8 * dt;
        vx += Math.cos(ang[i]) * spd[i] / aspect;
        vy += Math.sin(ang[i]) * spd[i];

        // chemotaxis (gradient in height units)
        const gx = (fieldAt(probe, x + eps, y) - fieldAt(probe, x - eps, y)) / (2 * eps * aspect);
        const gy = (fieldAt(probe, x, y + eps) - fieldAt(probe, x, y - eps)) / (2 * eps);
        let gm = Math.hypot(gx, gy);
        const gk = gm > 0 ? Math.min(gm * 0.002, 0.025) / gm : 0;
        vx += gx * gk / aspect;
        vy += gy * gk;

        // pointer: moths
        if (pointer && pointer.held) {
          const dx = (pointer.x - x) * aspect, dy = pointer.y - y;
          const d = Math.hypot(dx, dy);
          if (d < 0.25 && d > 1e-5) {
            const f = 1 - d / 0.25;
            const f2 = f * f * (3 - 2 * f);
            const nx = dx / d, ny = dy / d;
            const rad = (d - 0.06) * 0.6 * f2;     // inward when far, outward when very close
            const tan = 0.11 * f2;
            vx += (nx * rad - ny * tan) / aspect;
            vy += ny * rad + nx * tan;
          }
        }

        x += vx * dt;
        y += vy * dt;

        // soft bounce
        if (x < 0.01) { x = 0.01; ang[i] = Math.PI - ang[i]; }
        else if (x > 0.99) { x = 0.99; ang[i] = Math.PI - ang[i]; }
        if (y < 0.01) { y = 0.01; ang[i] = -ang[i]; }
        else if (y > 0.99) { y = 0.99; ang[i] = -ang[i]; }
        px[i] = x; py[i] = y;

        // life & energy
        sampleDye(probe, x, y, sd);
        const dens = smoothstep(0.05, 0.6, sd[0] + sd[1] + sd[2]);
        en[i] += (dens > 0.35 ? 0.05 * dens : -0.06 * (1 - dens / 0.35)) * dt;
        if (en[i] > 1) en[i] = 1;
        age[i] += dt;
        if (age[i] >= life[i] || en[i] <= 0) { kill(i); continue; }

        const fin = Math.min(1, age[i] / 1);
        const fout = Math.min(1, (life[i] - age[i]) / 2);
        const tw = 0.72 + 0.28 * Math.sin(clock * twRate[i] * 2.2 + twPh[i]);
        bright[i] = fin * fin * (3 - 2 * fin) * fout * smoothstep(0, 0.3, en[i]) * tw;

        alx[i] = 0; aly[i] = 0; alc[i] = 0; deg[i] = 0;
      }

      // --- links ---
      pairsCur.fill(0);
      let nv = 0;
      const maxD = LINK_DIST * LINK_KEEP;
      let newBest = 0, newX = 0, newY = 0, anyNew = false;
      for (let i = 0; i < N; i++) {
        if (!alive[i] || bright[i] < 0.05) continue;
        for (let j = i + 1; j < N; j++) {
          if (!alive[j] || bright[j] < 0.05) continue;
          if (deg[i] >= MAX_DEG) break;
          if (deg[j] >= MAX_DEG) continue;
          const dx = (px[j] - px[i]) * aspect, dy = py[j] - py[i];
          if (dx > maxD || dx < -maxD || dy > maxD || dy < -maxD) continue;
          const d = Math.sqrt(dx * dx + dy * dy);
          const key = i * N + j;
          const was = pairsPrev[key] === 1;
          if (d > (was ? maxD : LINK_DIST)) continue;
          pairsCur[key] = 1;
          deg[i]++; deg[j]++;
          const fall = 1 - d / maxD;
          const a = fall * Math.sqrt(fall) * Math.min(bright[i], bright[j]) * 0.25;
          if (nv + 6 <= lineData.length) {
            lineData[nv++] = px[i]; lineData[nv++] = py[i]; lineData[nv++] = a;
            lineData[nv++] = px[j]; lineData[nv++] = py[j]; lineData[nv++] = a;
          }
          // flocking: accumulate neighbour headings
          alx[i] += Math.cos(ang[j]); aly[i] += Math.sin(ang[j]); alc[i]++;
          alx[j] += Math.cos(ang[i]); aly[j] += Math.sin(ang[i]); alc[j]++;
          if (!was && a > newBest) {
            newBest = a; anyNew = true;
            newX = (px[i] + px[j]) * 0.5; newY = (py[i] + py[j]) * 0.5;
          }
        }
      }
      nLineVerts = nv / 3;

      for (let i = 0; i < N; i++) {
        if (!alive[i] || alc[i] === 0) continue;
        const target = Math.atan2(aly[i], alx[i]);
        let diff = target - ang[i];
        diff = Math.atan2(Math.sin(diff), Math.cos(diff));
        ang[i] += diff * Math.min(1, dt * 0.6);
      }

      linkCool -= dt;
      if (anyNew && linkCool <= 0 && motes.onLink) {
        linkCool = 0.25;
        motes.onLink(newX, newY, Math.min(1, newBest / 0.25));
      }

      const t = pairsPrev; pairsPrev = pairsCur; pairsCur = t;

      // --- upload buffers ---
      let np = 0;
      for (let i = 0; i < N; i++) {
        if (!alive[i]) continue;
        const o = np * 4;
        pointData[o] = px[i];
        pointData[o + 1] = py[i];
        pointData[o + 2] = size[i];
        pointData[o + 3] = bright[i];
        np++;
      }
      nPoints = np;
      dirty = true;
    },

    /**
     * Additive draw into the currently bound framebuffer.
     * @param {{aspect:number, color:number[], time:number}} p
     */
    draw({ color } = {}) {
      if (nPoints === 0) return;
      const c = color || [0.8, 0.9, 1.0];
      if (dirty) {
        gl.bindBuffer(gl.ARRAY_BUFFER, pointBuf);
        gl.bufferSubData(gl.ARRAY_BUFFER, 0, pointData, 0, nPoints * 4);
        if (nLineVerts > 0) {
          gl.bindBuffer(gl.ARRAY_BUFFER, lineBuf);
          gl.bufferSubData(gl.ARRAY_BUFFER, 0, lineData, 0, nLineVerts * 3);
        }
        gl.bindBuffer(gl.ARRAY_BUFFER, null);
        dirty = false;
      }
      gl.enable(gl.BLEND);
      gl.blendFunc(gl.ONE, gl.ONE);

      if (nLineVerts > 0) {
        lineProg.use();
        gl.uniform3f(lineProg.uniforms.uColor, c[0], c[1], c[2]);
        gl.bindVertexArray(lineVao);
        gl.drawArrays(gl.LINES, 0, nLineVerts);
      }

      pointProg.use();
      gl.uniform3f(pointProg.uniforms.uColor, c[0], c[1], c[2]);
      gl.uniform1f(pointProg.uniforms.uScale, gl.drawingBufferHeight * 0.011);
      gl.bindVertexArray(pointVao);
      gl.drawArrays(gl.POINTS, 0, nPoints);

      gl.bindVertexArray(null);
      gl.disable(gl.BLEND);
    },
  };

  let dirty = false;
  return motes;
}
