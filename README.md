# Eddy

**Play it: [eddy-ink.fly.dev](https://eddy-ink.fly.dev/)**

A slow, living pool of ink. You stir it, and it stirs back. Three pigments chase
each other through a real fluid, forming spirals that unwind and reform. Left
alone, it finds its own rhythm. There are no points and no goals.

Where ink dies it settles, and over minutes the pool grows a floor of sediment
that the currents carve and that steers the currents back. You can also share
your pool: one link, and someone else's hands are in the same ink as yours.

## How to play

Stir. Try different directions. Try holding still. Try a double-tap. Then wait.

Stay a while and watch the floor. Stir hard across it. Leave and come back: the
pool remembers.

## Share an easel

Press the share button (or `e`). The link is copied; send it to someone. Anyone
who opens it stirs the same pool with you, live, up to six people. A soft glow
shows where the others are touching. Leave from the same panel and the pool is
yours alone again.

An easel is private to whoever has its link. Nothing is stored on the server:
it only passes gestures between the people who are there, and each browser
keeps its own copy of the easels it has visited.

## Keyboard

| Key     | Action         |
| ------- | -------------- |
| `m`     | mute / unmute  |
| `f`     | fullscreen     |
| `s`     | save a PNG     |
| `space` | next season    |
| `c`     | clear the ink  |
| `C`     | clear the ink and scour the floor (shift + c) |
| `e`     | share this pool as an easel |

## Run locally

```sh
npm install
npm run dev
```

## Build

```sh
npm run build
```

The static site is written to `dist/`. To run the production server locally
(static files plus the easel relay on one port):

```sh
npm run build
npm start        # http://localhost:8080
npm test         # relay and static-server tests
```

## Versions

Every release stays playable at its own address, and the main site always shows
the newest one.

| Version | Play | What is new |
| --- | --- | --- |
| latest | [eddy-ink.fly.dev](https://eddy-ink.fly.dev/) | |
| v2 | [eddy-ink-v2.fly.dev](https://eddy-ink-v2.fly.dev/) | sediment, shared easels, the pool remembers |
| v1 | [eddy-ink-v1.fly.dev](https://eddy-ink-v1.fly.dev/) | the first pool |

## Deploy

The app is a static build served by a small Node process in Docker on Fly.io;
the same process hosts the WebSocket relay for shared easels. Each version runs
as its own Fly app, built from exactly the tagged commit, so an easel link
belongs to the version it was made on.

```sh
scripts/release.sh v3
```

That tags the current commit as `v3`, publishes a GitHub release, deploys it to
`eddy-ink-v3.fly.dev` and updates the latest site. Add a row to the table above
when you do. To redeploy an existing tag to its own address without touching the
latest site:

```sh
scripts/release.sh v1 --no-latest
```

To push work in progress to the latest site only, without making a release:

```sh
fly deploy
```

## How it works

- A WebGL2 stable-fluids simulation carries the ink.
- Three pigment species follow a cyclic predator-prey reaction (May-Leonard
  style), so each one overgrows the next. The flow moves them around.
- Colour is computed in OKLab from a triad of palette colours. The triad drifts
  through curated seasons over minutes.
- Sound is generative ambient audio (WebAudio) that follows the balance of the
  pigments.
- Sediment is one more simulation layer: ink that starves or fades settles onto
  a bed that remembers which pigment died there. Fast flow scours it and lifts
  it back into the water; the bed in turn drags, deflects and tilts the flow.
  It is drawn under the ink as dark relief with fine contour seams.
- A shared easel does not synchronise the simulation itself, which would be
  impossible across different GPUs. Every browser runs its own pool; gestures
  are relayed and applied everywhere, a newcomer receives a snapshot from the
  longest-present player (the keeper), and every few seconds the keeper sends a
  small low-resolution picture that the others lean their low frequencies
  toward, so the pools stay the same pool without losing their fine detail.
  See `DESIGN.md` for the wire format.

## Layout

```
index.html          shell markup
src/
  gl.js             shared WebGL2 helpers
  main.js           boot, frame loop, wiring
  sim.js            fluid and reaction simulation
  render.js         display shader, bloom, tonemap
  palette.js        colour seasons (OKLab)
  motes.js          motes and constellations
  audio.js          generative ambient audio
  input.js          pointer gestures
  drift.js          idle autopilot currents
  ui.js             controls, title card, keyboard, share panel
  easel.js          shared-easel relay client
  style.css         shell styles
server/
  index.js          static file server, /healthz
  relay.js          WebSocket relay for shared easels
  test.mjs          tests for both
public/
  favicon.svg
vite.config.js      attaches the relay to the dev server
Dockerfile          multi-stage: Vite build, then Node
fly.toml            Fly.io app config
```
