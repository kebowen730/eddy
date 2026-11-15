# Eddy — design & module contract

Eddy is an art game. No points, no goals, no text beyond a title that fades.
You stir a dark pool of living ink. It is soothing and flowy on the surface;
underneath, three "species" of pigment chase each other in a cyclic
predator–prey loop (A overgrows B, B overgrows C, C overgrows A), carried by a
real fluid simulation. Left alone, the ink organises itself into slow spiral
waves. The player discovers the rules by playing:

- **Stroke direction chooses the pigment.** The angle of your drag picks a point
  on the three-species wheel, so drawing a circle lays down the whole palette.
- **Holding still** opens a well that pulls ink inward; releasing it blooms.
- **Where all three species balance**, the ink turns to pearl and gives birth to
  motes — tiny lights that swim the currents and link into constellations.
- **Double-tap turns the tide**: the predator cycle reverses and every spiral
  unwinds.
- **Colour is never raw RGB.** Species are mapped through a triad of palette
  colours in OKLab; the triad drifts through curated "seasons" over minutes.
  Fronts between species shimmer with thin-film iridescence.
- **Sound** is a generative ambient bed that follows the balance of species.

## Stack

Vanilla JS ES modules, WebGL2, WebAudio, Vite for dev/build. No frameworks, no
runtime dependencies. Static build served by nginx in Docker on Fly.io.

## Files and owners

| File | What |
| --- | --- |
| `src/gl.js` | Shared WebGL2 helpers (already written — read it, use it, do not edit) |
| `src/main.js` | Boot, frame loop, wiring of everything (integrator writes) |
| `src/sim.js` | Fluid + reaction simulation |
| `src/render.js`, `src/palette.js` | Display shader, bloom, colour seasons |
| `src/motes.js` | Motes / constellations layer |
| `src/audio.js` | Generative ambient audio |
| `src/input.js`, `src/drift.js` | Pointer gestures; idle autopilot currents |
| `index.html`, `src/style.css`, `src/ui.js`, `Dockerfile`, `nginx.conf`, `fly.toml`, `README.md`, `.gitignore`, `.dockerignore` | Shell + deploy |

Each module is written by a different person at the same time. **Only create
the files you own.** Code against the contracts below exactly — names,
argument order and units matter because `main.js` is being written in parallel.

## Conventions

- Coordinates passed between modules are **normalised UV**: x in [0,1] left→right,
  y in [0,1] **bottom→top** (GL convention). `input.js` does the flip from DOM.
- `aspect` = width / height of the canvas.
- Velocities are in UV units per second (x-UV; a velocity of 1 crosses the
  screen width in one second). Aspect-correct inside shaders where needed.
- Species vector = `[a, b, c]`, each 0..1.
- `dt` is seconds, already clamped to ≤ 1/30 by main.
- All GPU modules receive the same `gl` (WebGL2RenderingContext). Leave GL state
  tidy: do not leave blending enabled, do not assume a bound framebuffer —
  always bind your own target. Blending is OFF by default.
- Plain modern JS, no TypeScript, no dependencies. JSDoc on exported functions.

## Contracts

### `src/sim.js`

```js
export function createSim(gl, { aspect }) -> sim
sim.params        // plain object of tunables, mutable live (see below)
sim.resize(aspect)                     // reallocate if aspect changed (keep it cheap; contents may reset or be resampled)
sim.splat(x, y, vx, vy, species, radius, amount)
   // inject force (vx,vy UV/s) and dye. species=[a,b,c] weights, radius in UV (fraction of height, ~0.02..0.1),
   // amount 0..1 dye strength. Queue-safe: may be called many times per frame.
sim.well(x, y, strength, radius)       // radial force toward (x,y) when strength>0, outward when <0. Per-frame call.
sim.step(dt)                           // advance fluid + reaction one frame
sim.dyeTex        // getter: WebGLTexture, rgb = species a,b,c densities (0..~1), LINEAR-filterable
sim.velocityTex   // getter: WebGLTexture, rg = velocity
sim.dyeSize       // [w,h] of dye texture
sim.probe()       // -> { w, h, dye: Uint8Array(w*h*4), vel: Uint8Array(w*h*4), balance:[a,b,c], density, energy }
   // low-res (32 wide x round(32/aspect) tall) RGBA8 readback, refreshed internally at most every ~6 frames
   // (cheap to call every frame; returns cached object). dye rgb = species*255 (clamped).
   // vel rg = clamp(v * params.probeVelScale * 0.5 + 0.5) * 255 (128 = zero; decode: (byte/255*2-1)/probeVelScale).
   // Row 0 is the BOTTOM row (GL readPixels order). balance = mean species normalised to sum 1 (or [1/3,1/3,1/3] if empty),
   // density = mean total species 0..1, energy = mean |v| (UV/s).
sim.clear(rate)   // begin a gentle dissolve: dye decays extra at `rate`/s until sim.clear(0)
```

`sim.params` must contain at least: `chirality` (+1 or -1: direction of the
predator cycle; main flips it on double-tap — the shader must read it every
step), `growth`, `predation`, `decay`, `diffusion`, `vorticity`,
`velocityDissipation`, `pressureIterations`, `probeVelScale` (default 4).

### `src/palette.js`

```js
export function createPalette() -> palette
palette.update(dt)            // advance season drift
palette.next()                // nudge toward the next season now (smooth, ~6 s crossfade)
palette.colors                // { a:[r,g,b], b:[r,g,b], c:[r,g,b], pearl:[r,g,b], deep:[r,g,b], accent:[r,g,b] }
                              // LINEAR-light sRGB floats (0..1), freshly interpolated in OKLab each update.
                              // deep = background/void colour (very dark, tinted). accent = mote colour.
palette.seasonIndex, palette.seasonName
export function oklchToLinearSrgb(L, C, hDegrees) -> [r,g,b]
```

### `src/render.js`

```js
export function createRenderer(gl) -> renderer
renderer.resize(pixelWidth, pixelHeight)
renderer.render({ dyeTex, velocityTex, dyeSize, time, colors, chirality, tide, overlay })
   // colors = palette.colors. tide = 0..1 pulse that decays after a tide-turn (use for a soft full-screen shimmer).
   // overlay: optional function () => void called AFTER the scene is composed into the HDR scene buffer and
   // BEFORE bloom/tonemap, with the scene framebuffer bound and viewport set, so motes get bloomed too.
   // Final output goes to the default framebuffer (canvas).
```

### `src/motes.js`

```js
export function createMotes(gl, { max = 220 } = {}) -> motes
motes.update(dt, probe, { aspect, pointer })   // probe from sim.probe(); pointer = {x,y,down,held} or null
motes.draw({ aspect, color, time })            // additive draw into the CURRENTLY BOUND framebuffer (HDR, float).
                                               // color = palette.colors.accent (linear). Must restore blend state (disable) after.
motes.count                                    // live motes
motes.onBirth = (x, y) => {}                   // optional callback, assigned by main
motes.onLink  = (x, y, strength) => {}         // optional callback when a new constellation link forms
```

### `src/audio.js`

```js
export function createAudio() -> audio
audio.start()                    // must be called from a user gesture; idempotent; creates/resumes AudioContext
audio.started                    // boolean
audio.setState({ balance, density, energy, season, chirality })  // called ~10x/s
audio.gesture({ x, y, speed, species })   // called while the player strokes (throttle internally)
audio.pluck(x, y, strength)      // soft bell: mote birth / link
audio.swell()                    // tide-turn: a slow reversed-feeling swell
audio.bloom(strength)            // well release
audio.setMuted(bool); audio.muted
```

### `src/input.js`

```js
export function createInput(canvas, handlers) -> input
// handlers (all optional):
//   onStroke({ id, x, y, vx, vy, speed, angle, pressure })  // per pointermove while down; v in UV/s (smoothed)
//   onHoldStart({ id, x, y })      // pointer down & nearly still for > 350 ms
//   onHold({ id, x, y, t })        // every frame while holding (t = seconds held) — driven by input.update(dt)
//   onHoldEnd({ id, x, y, t })     // pointer moved away or released after a hold
//   onDoubleTap({ x, y })
//   onFirstGesture()               // once, on the very first pointerdown/keydown (for audio.start)
//   onActivity()                   // any interaction
input.update(dt)                    // call every frame
input.pointers                      // Map id -> { x, y, down, held, heldTime }
input.primary                       // { x, y, down, held } of the most recent pointer, or null
input.idleTime                      // seconds since last interaction
```

### `src/drift.js`

```js
export function createDrift() -> drift
drift.update(dt, { idleTime, aspect, time }) -> Array<{ x, y, vx, vy, species, radius, amount }>
   // Autopilot: returns 0..n splats for this frame. Always emits a very faint ambient current;
   // after ~8 s idle it ramps up slow, graceful wandering strokes (Lissajous / curl-noise paths)
   // that paint on their own, so the piece is alive as a screensaver. Fades out instantly when idleTime resets.
```

### `src/ui.js`

```js
export function createUI({ onMute, onFullscreen, onSave, onNextSeason, onClear }) -> ui
ui.setMuted(bool)
ui.poke()                 // show the faint controls briefly (called on activity); they fade after ~3 s
ui.dismissTitle()         // fade the title card out (called on first gesture)
```

`index.html` contains `<canvas id="stage">` filling the viewport and loads
`/src/main.js` as a module. Keyboard: `m` mute, `f` fullscreen, `s` save PNG,
`space` next season, `c` clear — `ui.js` binds these and calls the callbacks.
