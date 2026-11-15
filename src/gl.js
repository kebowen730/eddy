// Shared WebGL2 helpers. Every GPU module uses these — do not duplicate them.

/** Attribute-less fullscreen triangle. Provides `vUv` in [0,1]. Use with drawFullscreen(). */
export const FULLSCREEN_VS = `#version 300 es
precision highp float;
out vec2 vUv;
void main() {
  vec2 p = vec2(float((gl_VertexID << 1) & 2), float(gl_VertexID & 2));
  vUv = p;
  gl_Position = vec4(p * 2.0 - 1.0, 0.0, 1.0);
}`;

function compile(gl, type, src) {
  const s = gl.createShader(type);
  gl.shaderSource(s, src);
  gl.compileShader(s);
  if (!gl.getShaderParameter(s, gl.COMPILE_STATUS)) {
    const log = gl.getShaderInfoLog(s);
    const numbered = src.split('\n').map((l, i) => `${i + 1}: ${l}`).join('\n');
    console.error(numbered);
    throw new Error('Shader compile failed: ' + log);
  }
  return s;
}

/**
 * Compile + link. Returns { program, uniforms, use() } where `uniforms` maps every
 * active uniform name (array names without "[0]") to its WebGLUniformLocation.
 * Fragment sources must start with `#version 300 es`.
 */
export function createProgram(gl, vsSrc, fsSrc) {
  const program = gl.createProgram();
  gl.attachShader(program, compile(gl, gl.VERTEX_SHADER, vsSrc));
  gl.attachShader(program, compile(gl, gl.FRAGMENT_SHADER, fsSrc));
  gl.linkProgram(program);
  if (!gl.getProgramParameter(program, gl.LINK_STATUS)) {
    throw new Error('Program link failed: ' + gl.getProgramInfoLog(program));
  }
  const uniforms = {};
  const n = gl.getProgramParameter(program, gl.ACTIVE_UNIFORMS);
  for (let i = 0; i < n; i++) {
    const info = gl.getActiveUniform(program, i);
    const name = info.name.replace(/\[0\]$/, '');
    uniforms[name] = gl.getUniformLocation(program, info.name);
  }
  return { program, uniforms, use() { gl.useProgram(program); } };
}

let _vao = null;
let _vaoGl = null;
/** Draw the fullscreen triangle with the currently bound program + framebuffer. */
export function drawFullscreen(gl) {
  if (_vaoGl !== gl) { _vao = gl.createVertexArray(); _vaoGl = gl; }
  gl.bindVertexArray(_vao);
  gl.drawArrays(gl.TRIANGLES, 0, 3);
}

let _caps = null;
/**
 * Enables float render targets. Returns { floatTargets, linearFloat }.
 * RGBA16F + HALF_FLOAT render targets are available when floatTargets is true.
 * If linearFloat is false, float textures must use NEAREST filtering
 * (createFBO handles this automatically).
 */
export function getCaps(gl) {
  if (_caps && _caps.gl === gl) return _caps;
  const floatTargets = !!gl.getExtension('EXT_color_buffer_float') ||
    !!gl.getExtension('EXT_color_buffer_half_float');
  const linearFloat = !!gl.getExtension('OES_texture_float_linear') ||
    !!gl.getExtension('OES_texture_half_float_linear');
  _caps = { gl, floatTargets, linearFloat };
  return _caps;
}

/**
 * Create a render target.
 * opts.float (default true): RGBA16F/HALF_FLOAT. false: RGBA8/UNSIGNED_BYTE.
 * opts.filter: gl.LINEAR (default) or gl.NEAREST.
 * opts.wrap: gl.CLAMP_TO_EDGE (default) or gl.REPEAT / gl.MIRRORED_REPEAT.
 * Returns { tex, fbo, w, h, texel:[1/w,1/h], bind() }. bind() binds the FBO and sets the viewport.
 */
export function createFBO(gl, w, h, opts = {}) {
  const caps = getCaps(gl);
  const isFloat = opts.float !== false && caps.floatTargets;
  let filter = opts.filter ?? gl.LINEAR;
  if (isFloat && !caps.linearFloat) filter = gl.NEAREST;
  const wrap = opts.wrap ?? gl.CLAMP_TO_EDGE;
  w = Math.max(1, Math.round(w));
  h = Math.max(1, Math.round(h));
  const tex = gl.createTexture();
  gl.bindTexture(gl.TEXTURE_2D, tex);
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, filter);
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, filter);
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, wrap);
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, wrap);
  if (isFloat) gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA16F, w, h, 0, gl.RGBA, gl.HALF_FLOAT, null);
  else gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA8, w, h, 0, gl.RGBA, gl.UNSIGNED_BYTE, null);
  const fbo = gl.createFramebuffer();
  gl.bindFramebuffer(gl.FRAMEBUFFER, fbo);
  gl.framebufferTexture2D(gl.FRAMEBUFFER, gl.COLOR_ATTACHMENT0, gl.TEXTURE_2D, tex, 0);
  gl.viewport(0, 0, w, h);
  gl.clearColor(0, 0, 0, 0);
  gl.clear(gl.COLOR_BUFFER_BIT);
  gl.bindFramebuffer(gl.FRAMEBUFFER, null);
  return {
    tex, fbo, w, h, texel: [1 / w, 1 / h],
    bind() { gl.bindFramebuffer(gl.FRAMEBUFFER, fbo); gl.viewport(0, 0, w, h); },
    dispose() { gl.deleteTexture(tex); gl.deleteFramebuffer(fbo); },
  };
}

/** Ping-pong pair. { read, write, swap(), w, h, texel, dispose() } */
export function createDoubleFBO(gl, w, h, opts = {}) {
  let a = createFBO(gl, w, h, opts);
  let b = createFBO(gl, w, h, opts);
  return {
    get read() { return a; },
    get write() { return b; },
    swap() { const t = a; a = b; b = t; },
    w: a.w, h: a.h, texel: a.texel,
    dispose() { a.dispose(); b.dispose(); },
  };
}

/** Bind `tex` to texture unit `unit` and point sampler uniform `loc` at it. */
export function bindTex(gl, loc, tex, unit) {
  gl.activeTexture(gl.TEXTURE0 + unit);
  gl.bindTexture(gl.TEXTURE_2D, tex);
  gl.uniform1i(loc, unit);
}
