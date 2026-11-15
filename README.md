# Eddy

A slow, living pool of ink. You stir it, and it stirs back. Three pigments chase
each other through a real fluid, forming spirals that unwind and reform. Left
alone, it finds its own rhythm. There are no points and no goals.

## How to play

Stir. Try different directions. Try holding still. Try a double-tap. Then wait.

## Keyboard

| Key     | Action         |
| ------- | -------------- |
| `m`     | mute / unmute  |
| `f`     | fullscreen     |
| `s`     | save a PNG     |
| `space` | next season    |
| `c`     | clear the pool |

## Run locally

```sh
npm install
npm run dev
```

## Build

```sh
npm run build
```

The static site is written to `dist/`.

## Deploy

```sh
fly deploy
```

The app is a static build served by nginx in Docker on Fly.io.

## How it works

- A WebGL2 stable-fluids simulation carries the ink.
- Three pigment species follow a cyclic predator-prey reaction (May-Leonard
  style), so each one overgrows the next. The flow moves them around.
- Colour is computed in OKLab from a triad of palette colours. The triad drifts
  through curated seasons over minutes.
- Sound is generative ambient audio (WebAudio) that follows the balance of the
  pigments.

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
  ui.js             controls, title card, keyboard
  style.css         shell styles
public/
  favicon.svg
Dockerfile          multi-stage: Vite build, then nginx
nginx.conf          static serving, caching, /healthz
fly.toml            Fly.io app config
```
