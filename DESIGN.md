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

---

# v2: sediment and shared easels

Two additions. Everything above still holds; this section is the contract for the change.

## What it is

**Sediment.** The pool has a floor. Where ink dies (starves in a single-species region, or
thins below the Allee threshold and fades), part of it settles and stays. Over minutes the
floor builds relief. Rules the player discovers:

- Dead ink leaves terrain, and the terrain remembers which pigment died there.
- Fast currents scour the floor; scoured silt rises again as a faint ghost of its old colour
  and resettles downstream. Stirring hard carves channels, still water silts up.
- The floor steers the pool: flow slows over shoals, turns to run along ridges, and heavy ink
  slides downhill into channels. Ink grows a little more readily over old sediment.
- The floor is drawn under the ink as dark mineral relief with fine luminous contour seams,
  coloured through the *current* season's palette, so old strata recolour as seasons turn.
- `c` clears the ink but not the floor. `Shift+C` scours the floor too.
- The pool (ink + floor) is saved in the browser and restored on the next visit.

**Shared easel.** Not a global shared world. A player may press *share* to turn their pool
into an easel with a private link (`/e/<id>`). Anyone who opens the link stirs the same pool
live: each person's strokes, wells, blooms, tide-turns, season changes and clears appear in
everyone's pool, with a soft glow where the other person is touching. Up to 6 people.

How it works: every browser runs its own simulation. Gestures are relayed through a tiny
WebSocket relay and applied to each simulation. Because GPU fluid sims drift apart, the
longest-connected person is the **keeper**: a newcomer receives the keeper's full snapshot
(ink + floor), and every few seconds the keeper sends a small low-resolution snapshot that
the others nudge their low frequencies toward. The server stores nothing; each browser saves
the easels it has visited in `localStorage`, so the first person back into an empty easel
brings its last state with them.

## Stack change

The static nginx container is replaced by one small Node process that serves `dist/` and
hosts the WebSocket relay on the same port (8080). One server dependency: `ws`. The client
still has no runtime dependencies. In dev the relay is attached to Vite's own server by a
plugin in `vite.config.js`, so `npm run dev` is still the only command.

## Files and owners (v2)

| File | Owner | Change |
| --- | --- | --- |
| `src/sim.js` | sim agent | sediment bed, steering, capture / restore, scour |
| `src/render.js` | render agent | draw the floor |
| `server/relay.js`, `server/index.js`, `server/test.mjs`, `vite.config.js`, `Dockerfile`, `.dockerignore`, `fly.toml`, remove `nginx.conf` | server agent | relay + static server |
| `src/easel.js` | easel agent | relay client |
| `src/ui.js`, `index.html`, `src/style.css` | ui agent | share button and panel, toast, presence, remote glows |
| `src/main.js`, `src/palette.js`, `package.json`, `README.md`, `DESIGN.md` | lead | wiring, persistence |

Only touch the files you own. `src/gl.js` is shared and read-only.

## Contract: `src/sim.js` additions

The bed is one more ping-pong RGBA16F target at the **dye grid resolution**. `rgb` = settled
mass of species a, b, c (each >= 0); height `h = r + g + b`, soft-capped at `params.bedMax`.
The bed is never advected. It is stretched on `resize` exactly like the dye.

New `params` (all live-tunable; the numbers are starting points):

```js
bedDeposit: 0.5,    // fraction of dying ink mass that settles (0 disables sediment)
bedMax: 1.0,        // soft cap on bed height
bedErode: 0.5,      // scour rate (1/s) of the bed under full-speed flow
bedErodeLo: 0.12,   // flow speed (heights/s) where scouring starts
bedErodeHi: 0.8,    // flow speed where scouring is at full rate
bedLift: 0.5,       // fraction of scoured sediment that returns to the water as ink
bedSettle: 0.003,   // slow uniform decay of the bed (1/s)
bedSmooth: 0.05,    // diffusion of the bed in cell^2/s, keeps relief smooth
bedDrag: 1.0,       // extra velocity damping (1/s) per unit bed height
bedDeflect: 3.0,    // how strongly flow heading uphill is turned along the contours
bedSlope: 0.5,      // downhill acceleration of ink: f = -bedSlope * rho * grad(h)
bedFertility: 0.3,  // 0..1: how much a full bed lowers the Allee threshold / boosts growth
```

"Dying" mass per species per second is the non-predation loss in the reaction:
`c_i * (decay + starve * (1 - live) + voidFade * (1 - gate))`. Predation is not death.

New API on the sim object:

```js
sim.bedTex            // WebGLTexture (getter), current bed
sim.bedSize           // [w, h] of the bed grid (same as dyeSize)
sim.scour(rate)       // like clear(rate) but for the bed: extra decay per second; 0 ends it
sim.capture(width = 160)
  // -> { w, h, dye: Uint8Array(w*h*4), bed: Uint8Array(w*h*4) }   (fresh arrays every call)
  // h = max(1, round(width / aspect)). Row 0 = bottom. Area-averaged downsample.
  // Encoding for rgb of both: byte = round(255 * sqrt(clamp(value / 1.5, 0, 1))). alpha = 255.
sim.restore(snap, { blend = 1, dye = true, bed = true } = {})
  // snap has the capture() shape (any w,h up to 512; stretched UV-to-UV to this grid).
  // blend >= 1: replace the field with the bilinearly upsampled snapshot.
  // blend <  1: low-frequency nudge. x = max(0, x + blend * (S - L)) where S is the upsampled
  //             snapshot and L is the local field area-averaged to the snapshot's resolution
  //             and upsampled the same way. Fine local detail must survive a nudge untouched.
  // Velocity and pressure are not touched. Invalid input (wrong lengths, w/h out of 1..512)
  // is ignored silently.
```

`reset()` also wipes the bed. `probe()` gains `sediment`: mean bed height, 0..1.
`sim.SNAP_MAX` is not needed; the constant 1.5 is part of this contract.

## Contract: `src/render.js` additions

`render()` accepts two more fields: `bedTex` (WebGLTexture or null/undefined = no floor) and
`bedSize` (`[w, h]`). Nothing else about the call changes.

## Contract: relay server

`server/relay.js` exports `attachRelay(httpServer, opts = {})`; it handles `upgrade` requests
whose path matches `/ws/<id>` and **ignores every other upgrade** (Vite's HMR socket shares
the server in dev). `opts.allowAnyOrigin` (default false) disables the origin check for tests.

- Easel id: `^[a-z0-9]{8,32}$`. Path: `/ws/<id>`.
- Origin check: the `Origin` header's host must equal the `Host` header.
- A room holds up to **6** peers. Peer ids are integers 1..250, unique within a room.
- The **keeper** is the longest-connected peer in the room.
- Server -> client JSON (text frames):
  - on connect: `{"t":"hello","id":<self>,"peers":[<others>],"keeper":<id>}`
  - to the others: `{"t":"join","id":<id>}`
  - on disconnect, to the rest: `{"t":"leave","id":<id>,"keeper":<id>}`
- Client JSON text frames (max 16 KB) must parse to an object with a string `t` of 1..12
  chars that is not `hello`, `join` or `leave`. The server sets `from` to the sender's id and
  relays to every other peer, or only to peer `to` if the message has a numeric `to` (which
  is removed). Anything else is dropped.
- Binary frames (max 400 KB, min 8 bytes): byte 1 is the recipient peer id, 0 = all others.
  The server overwrites byte 1 with the sender's id and relays. It reads nothing else.
- Rate limit per connection: token bucket, 90 messages/s, burst 180; excess is dropped; a
  connection that is still over the limit after 5 s is closed.
- Close codes: 4000 bad id, 4001 room full, 4003 bad origin, 4008 rate limit.
- Ping every 25 s; terminate sockets that miss a pong. Empty rooms are deleted. The server
  keeps no easel state.

`server/index.js`: Node http server on `PORT` (default 8080), serves `dist/` (loaded into
memory at boot, gzip for text types, `/assets/*` immutable for a year, everything else
`no-cache`), `GET /healthz` -> `200 ok\n`, any extensionless unknown path -> `index.html`,
unknown path with an extension -> 404. Headers on every response:
`X-Content-Type-Options: nosniff`, `Referrer-Policy: no-referrer`.

## Contract: wire format (client <-> client, through the relay)

JSON:

- `{"t":"f","s":[[x,y,vx,vy,a,b,c,r,amt],...],"w":[[x,y,strength,radius],...]}`: a batch of
  splats and wells, flushed at most 30 times a second, at most 48 splats and 12 wells each.
  Numbers rounded to 4 decimals. Either array may be omitted.
- `{"t":"ev","k":<kind>,"d":{...}}`: `tide` `{x,y,chirality}`, `season` `{index}`,
  `clear` `{scour:boolean}`, `state` `{season,chirality}`.
- `{"t":"want"}`: a newcomer asks for the full snapshot. Only the keeper answers.

Binary snapshot: 8-byte header `[kind u8][peer u8][w u16 LE][h u16 LE][0][0]`, then
`w*h*3` bytes of dye RGB, then `w*h*3` bytes of bed RGB (alpha dropped; row 0 = bottom;
encoding as `sim.capture`). `kind` 1 = full (answer to `want`), 2 = sync (periodic nudge).

Receivers validate everything: finite numbers, x/y clamped to 0..1, |v| <= 8, radius
0.001..0.5, amount 0..1.5, |strength| <= 8, species components 0..1, array caps as above,
snapshot `w`,`h` in 1..512 and exact payload length. Invalid items are dropped.

## Contract: `src/easel.js`

```js
export function easelIdFromLocation()   // id from a path like /e/<id>, else null
export function linkFor(id)             // absolute URL: location.origin + '/e/' + id
export function createEasel(handlers)   // -> easel
// handlers (all optional):
//   onStatus(status)   'off' | 'connecting' | 'live' | 'reconnecting' | 'full'
//   onPeers(peers, selfId, keeperId)       peers = ids of the OTHER people, number[]
//   onSplat(from, x, y, vx, vy, species, radius, amount)   species is a reused [a,b,c]
//   onWell(from, x, y, strength, radius)
//   onEvent(from, kind, data)              kind and data as in the wire format
//   onSnapshot(from, kind, snap)           kind 'full' | 'sync'; snap {w,h,dye,bed} RGBA
//   onWant(from)                           only called when this client is the keeper
// easel:
//   id, status, selfId, keeperId, isKeeper, peers   (live getters)
//   create()            -> new id (10 chars a-z0-9 from crypto.getRandomValues); joins it
//   join(id)            connect to ws(s)://<host>/ws/<id>
//   leave()             disconnect; status 'off'
//   splat(x, y, vx, vy, species, radius, amount)    queue for the next flush
//   well(x, y, strength, radius)                    queue for the next flush
//   send(kind, data)                                send an "ev" now
//   sendSnapshot(kind, snap, to = 0)                kind 'full' | 'sync'
//   update(dt)                                      call every frame; flushes the queues
```

Every send is a no-op unless status is `live`. Reconnects with backoff (1, 2, 4, 8, 15 s) on
an unexpected close; close code 4001 gives status `full` and no retry; other 40xx: no retry.
On every (re)connect with other peers present, the client sends `want` once.
`snap` arrays passed in and out are RGBA (`w*h*4`), matching `sim.capture`.

## Contract: `src/ui.js` additions

```js
createUI({ ...existing, onShare, onLeave, onScour })
//   onShare(): string   returns the link to share (the lead creates the easel if needed).
//                       Called inside the click/key handler so the UI can copy it at once.
//   onLeave(): void
//   onScour(): void     Shift+C
// keys: `e` = share (same as the button); `Shift+C` = onScour; plain `c` still onClear.
ui.setEasel({ status, link, count })   // status as easel.status; link string or null;
                                       // count = people here including you
ui.toast(text)                         // one quiet line, fades after ~3.5 s
ui.setHint(text)                       // replace the title card's hint word(s)
ui.remoteTouch(peerId, x, y)           // UV, y up. Soft glow for that peer; fades in ~1.2 s
ui.dropPeer(peerId)                    // remove that peer's glow
```
