// Eddy generative audio: a slow pad bed that follows the pool, plus soft bells.
// Pure WebAudio, no samples. See DESIGN.md for the contract.

const MASTER_LEVEL = 0.5;
const MAX_ALIVE = 24;

// Seasons: root (MIDI) and scale intervals. All consonant (pentatonic-ish).
const SEASONS = [
  { root: 38, scale: [0, 2, 4, 7, 9] },        // D lydian pentatonic
  { root: 45, scale: [0, 2, 3, 5, 7, 10] },    // A minor pentatonic add9
  { root: 41, scale: [0, 2, 4, 7, 9] },        // F major 6/9
  { root: 40, scale: [0, 2, 3, 7, 10] },       // E dorian-ish (sus)
  { root: 43, scale: [0, 2, 4, 7, 10] },       // G mixolydian pentatonic
  { root: 36, scale: [0, 2, 4, 7, 11] },       // C maj7 pentatonic
  { root: 46, scale: [0, 2, 4, 7, 9] },        // Bb major pentatonic
  { root: 47, scale: [0, 2, 3, 5, 7, 10] },    // B minor pentatonic add9
  { root: 39, scale: [0, 2, 4, 7, 11] },       // Eb maj7 pentatonic
];

// Voice offsets (semitones above season root) for [low, mid, high].
const VOICING = {
  normal: [12, 19, 26],
  reversed: [7, 14, 19],
};

const clamp = (v, a, b) => (v < a ? a : v > b ? b : v);
const num = (v, d) => (typeof v === 'number' && Number.isFinite(v) ? v : d);
const mtof = (m) => 440 * Math.pow(2, (m - 69) / 12);
const rand = (a, b) => a + Math.random() * (b - a);

/**
 * Create the generative audio engine. Nothing sounds until `start()` is called
 * from a user gesture; every other method is a safe no-op before that.
 * @returns {{
 *  start: () => void,
 *  readonly started: boolean,
 *  setState: (s: {balance?: number[], density?: number, energy?: number, season?: number, chirality?: number}) => void,
 *  gesture: (g: {x: number, y: number, speed: number, species?: number[]}) => void,
 *  pluck: (x: number, y: number, strength?: number) => void,
 *  swell: () => void,
 *  bloom: (strength?: number) => void,
 *  setMuted: (m: boolean) => void,
 *  readonly muted: boolean
 * }}
 */
export function createAudio() {
  let ctx = null;
  let started = false;
  let muted = false;
  let alive = 0;

  // graph
  let master, bus, conv, noiseBuf, waterGain, waterFilter, padBus;
  let voices = [];

  // state
  const st = { balance: [1 / 3, 1 / 3, 1 / 3], density: 0, energy: 0, season: 0, chirality: 1 };
  let appliedSeason = -1;
  let appliedChir = 0;
  let nextGesture = 0;
  let lastPluck = 0;
  let lastSwell = -10;

  const seasonOf = () => SEASONS[((Math.round(st.season) % SEASONS.length) + SEASONS.length) % SEASONS.length];

  function makeImpulse(c, seconds) {
    const sr = c.sampleRate;
    const len = Math.floor(sr * seconds);
    const buf = c.createBuffer(2, len, sr);
    for (let ch = 0; ch < 2; ch++) {
      const d = buf.getChannelData(ch);
      let lp = 0;
      for (let i = 0; i < len; i++) {
        const t = i / len;
        const env = Math.exp(-t * 7.5) * (1 - Math.exp(-i / (sr * 0.02)));
        // darker tail: one-pole lowpass whose cutoff falls with time
        const k = 0.65 - 0.5 * t; // 0.65 -> 0.15
        lp += k * ((Math.random() * 2 - 1) - lp);
        d[i] = lp * env * 1.6;
      }
    }
    return buf;
  }

  function makeNoise(c, seconds) {
    const sr = c.sampleRate;
    const len = Math.floor(sr * seconds);
    const buf = c.createBuffer(1, len, sr);
    const d = buf.getChannelData(0);
    let b = 0;
    for (let i = 0; i < len; i++) {
      b = (b + 0.03 * (Math.random() * 2 - 1)) / 1.03;
      d[i] = clamp(b * 5, -1, 1);
    }
    // crossfade the loop seam
    const f = Math.min(1024, len >> 2);
    for (let i = 0; i < f; i++) {
      const a = i / f;
      d[i] = d[i] * a + d[len - f + i] * (1 - a) * 0; // start ramp (avoid seam click)
      d[len - 1 - i] *= a;
    }
    return buf;
  }

  function makePanner(c, value) {
    if (typeof c.createStereoPanner !== 'function') return null;
    const p = c.createStereoPanner();
    p.pan.value = clamp(value, -1, 1);
    return p;
  }

  function buildGraph() {
    const Ctor = window.AudioContext || window.webkitAudioContext;
    if (!Ctor) throw new Error('no WebAudio');
    try { ctx = new Ctor({ latencyHint: 'playback' }); } catch (e) { ctx = new Ctor(); }

    master = ctx.createGain();
    master.gain.value = 0;
    master.connect(ctx.destination);

    const comp = ctx.createDynamicsCompressor();
    comp.threshold.value = -18;
    comp.knee.value = 24;
    comp.ratio.value = 4;
    comp.attack.value = 0.01;
    comp.release.value = 0.3;
    comp.connect(master);

    bus = ctx.createGain();
    const lp = ctx.createBiquadFilter();
    lp.type = 'lowpass';
    lp.frequency.value = 7000;
    lp.Q.value = 0.4;
    bus.connect(lp);

    const dry = ctx.createGain();
    dry.gain.value = 0.7;
    lp.connect(dry);
    dry.connect(comp);

    conv = ctx.createConvolver();
    conv.buffer = makeImpulse(ctx, 5);
    const wet = ctx.createGain();
    wet.gain.value = 0.6;
    lp.connect(conv);
    conv.connect(wet);
    wet.connect(comp);

    // pad bus
    padBus = ctx.createGain();
    padBus.gain.value = 0.06;
    padBus.connect(bus);

    // water noise
    noiseBuf = makeNoise(ctx, 4);
    const ns = ctx.createBufferSource();
    ns.buffer = noiseBuf;
    ns.loop = true;
    waterFilter = ctx.createBiquadFilter();
    waterFilter.type = 'bandpass';
    waterFilter.frequency.value = 500;
    waterFilter.Q.value = 0.5;
    waterGain = ctx.createGain();
    waterGain.gain.value = 0;
    ns.connect(waterFilter);
    waterFilter.connect(waterGain);
    waterGain.connect(bus);
    ns.start();

    // voices
    const pans = [-0.35, 0.05, 0.35];
    const lfoRates = [0.045, 0.071, 0.103];
    const panRates = [0.031, 0.047, 0.037];
    const types = [
      [['sine', 0.5, 0], ['triangle', 0.35, 6], ['sawtooth', 0.04, -7]],
      [['sine', 0.45, 0], ['triangle', 0.35, -5], ['sawtooth', 0.035, 8]],
      [['sine', 0.5, 0], ['triangle', 0.25, 7]],
    ];
    voices = [];
    for (let i = 0; i < 3; i++) {
      const lowpass = ctx.createBiquadFilter();
      lowpass.type = 'lowpass';
      lowpass.frequency.value = 600;
      lowpass.Q.value = 0.3;

      const level = ctx.createGain(); // balance-driven
      level.gain.value = 0.08;
      const lfoGain = ctx.createGain(); // slow tremolo
      lfoGain.gain.value = 0.75;
      const panner = makePanner(ctx, pans[i]);

      lowpass.connect(level);
      level.connect(lfoGain);
      if (panner) { lfoGain.connect(panner); panner.connect(padBus); } else lfoGain.connect(padBus);

      const lfo = ctx.createOscillator();
      lfo.type = 'sine';
      lfo.frequency.value = lfoRates[i];
      const lfoDepth = ctx.createGain();
      lfoDepth.gain.value = 0.25;
      lfo.connect(lfoDepth);
      lfoDepth.connect(lfoGain.gain);
      lfo.start();

      if (panner) {
        const plfo = ctx.createOscillator();
        plfo.type = 'sine';
        plfo.frequency.value = panRates[i];
        const pd = ctx.createGain();
        pd.gain.value = 0.4;
        plfo.connect(pd);
        pd.connect(panner.pan);
        plfo.start();
      }

      const oscs = [];
      for (const [type, g, det] of types[i]) {
        const o = ctx.createOscillator();
        o.type = type;
        o.frequency.value = 110;
        o.detune.value = det;
        const og = ctx.createGain();
        og.gain.value = g;
        o.connect(og);
        og.connect(lowpass);
        o.start();
        oscs.push({ osc: o, base: det });
      }
      voices.push({ oscs, lowpass, level, freq: 110 });
    }
  }

  function applyTuning(tc) {
    const s = seasonOf();
    const vo = st.chirality < 0 ? VOICING.reversed : VOICING.normal;
    const now = ctx.currentTime;
    for (let i = 0; i < 3; i++) {
      const f = clamp(mtof(s.root + vo[i]), 20, 4000);
      voices[i].freq = f;
      for (const o of voices[i].oscs) o.osc.frequency.setTargetAtTime(f, now, tc);
    }
    applyDynamics();
  }

  function applyDynamics() {
    const now = ctx.currentTime;
    const b = st.balance;
    const e = clamp(st.energy / 0.4, 0, 1);
    for (let i = 0; i < 3; i++) {
      const v = voices[i];
      const lvl = 0.03 + 0.11 * Math.min(1.6, b[i] * 3);
      v.level.gain.setTargetAtTime(lvl, now, 2.5);
      const cut = clamp(v.freq * (2.2 + 5 * e), 300, 7000);
      v.lowpass.frequency.setTargetAtTime(cut, now, 2);
    }
    const d = clamp(st.density * 2.2, 0, 1);
    padBus.gain.setTargetAtTime(0.06 + 1.1 * Math.sqrt(d) * 0.94, now, 2.5);
    waterGain.gain.setTargetAtTime(0.012 + 0.09 * e * e + 0.03 * e, now, 1.5);
    waterFilter.frequency.setTargetAtTime(350 + 1400 * e, now, 1.5);
  }

  /** One soft mallet/bell note. */
  function note(o) {
    if (!ctx || muted || alive >= MAX_ALIVE) return;
    const t = o.t != null ? o.t : ctx.currentTime;
    const freq = clamp(num(o.freq, 440), 30, 9000);
    const attack = o.attack || 0.015;
    const decay = o.decay || 2;
    const peak = clamp(num(o.gain, 0.03), 0.0001, 0.3);
    const stopAt = t + attack + decay * 1.5;

    const env = ctx.createGain();
    env.gain.setValueAtTime(0, t);
    env.gain.linearRampToValueAtTime(peak, t + attack);
    env.gain.setTargetAtTime(0, t + attack, decay / 5);

    const nodes = [env];
    const o1 = ctx.createOscillator();
    o1.type = o.type || 'sine';
    o1.frequency.value = freq;
    o1.connect(env);
    const srcs = [o1];

    const pf = freq * (o.partial || 2.76);
    if (o.pg > 0 && pf < 12000) {
      const o2 = ctx.createOscillator();
      o2.type = 'sine';
      o2.frequency.value = pf;
      const g2 = ctx.createGain();
      g2.gain.value = o.pg;
      o2.connect(g2);
      g2.connect(env);
      nodes.push(g2);
      srcs.push(o2);
    }

    const pan = makePanner(ctx, clamp(num(o.pan, 0), -1, 1));
    let out = env;
    if (pan) { env.connect(pan); nodes.push(pan); out = pan; }
    out.connect(bus);
    if (o.rev > 0) {
      const rg = ctx.createGain();
      rg.gain.value = o.rev;
      out.connect(rg);
      rg.connect(conv);
      nodes.push(rg);
    }

    alive++;
    o1.onended = () => {
      alive = Math.max(0, alive - 1);
      for (const s of srcs) { try { s.disconnect(); } catch (e) { /* ignore */ } }
      for (const n of nodes) { try { n.disconnect(); } catch (e) { /* ignore */ } }
    };
    for (const s of srcs) { s.start(t); s.stop(stopAt); }
  }

  function degreeMidi(idx, base) {
    const sc = seasonOf().scale;
    const n = sc.length;
    return base + sc[idx % n] + 12 * Math.floor(idx / n);
  }

  function visibility() {
    if (!ctx || !started) return;
    if (document.hidden) {
      try { const p = ctx.suspend(); if (p && p.catch) p.catch(() => {}); } catch (e) { /* ignore */ }
    } else if (!muted) {
      try { const p = ctx.resume(); if (p && p.catch) p.catch(() => {}); } catch (e) { /* ignore */ }
    }
  }
  if (typeof document !== 'undefined') document.addEventListener('visibilitychange', visibility);

  function rampMaster(target, secs) {
    const now = ctx.currentTime;
    const g = master.gain;
    const cur = num(g.value, 0);
    g.cancelScheduledValues(now);
    g.setValueAtTime(cur, now);
    g.linearRampToValueAtTime(target, now + secs);
  }

  const api = {
    start() {
      if (started) {
        if (ctx && ctx.state !== 'running' && !muted) { try { ctx.resume().catch(() => {}); } catch (e) { /* ignore */ } }
        return;
      }
      try {
        if (!ctx) buildGraph();
        const p = ctx.resume();
        if (p && p.catch) p.catch(() => {});
        started = true;
        appliedSeason = st.season;
        appliedChir = st.chirality;
        applyTuning(0.05);
        rampMaster(muted ? 0 : MASTER_LEVEL, muted ? 0.1 : 4);
      } catch (e) {
        started = false;
        if (typeof console !== 'undefined') console.warn('[eddy] audio unavailable', e);
      }
    },
    get started() { return started; },

    setState(s) {
      if (!s) return;
      if (Array.isArray(s.balance) && s.balance.length >= 3) {
        const b = [0, 1, 2].map((i) => clamp(num(s.balance[i], 0), 0, 1));
        const sum = b[0] + b[1] + b[2];
        st.balance = sum > 1e-6 ? b.map((v) => v / sum) : [1 / 3, 1 / 3, 1 / 3];
      }
      st.density = clamp(num(s.density, st.density), 0, 1);
      st.energy = clamp(num(s.energy, st.energy), 0, 2);
      const seasonIn = Math.round(num(s.season, st.season));
      const chirIn = num(s.chirality, st.chirality) < 0 ? -1 : 1;
      const changed = seasonIn !== st.season || chirIn !== st.chirality;
      st.season = seasonIn;
      st.chirality = chirIn;
      if (!started) return;
      if (changed) applyTuning(2.7); // ~8 s glide
      else applyDynamics();
      appliedSeason = st.season;
      appliedChir = st.chirality;
    },

    gesture(g) {
      if (!started || muted || !g) return;
      const now = ctx.currentTime;
      if (now < nextGesture) return;
      const speed = clamp(num(g.speed, 0), 0, 4);
      if (speed < 0.02) return;
      const interval = (0.4 - 0.22 * clamp(speed / 1.5, 0, 1)) * rand(0.9, 1.25);
      nextGesture = now + interval;
      if (Math.random() < 0.35) return;

      const sp = Array.isArray(g.species) ? g.species : [1, 0, 0];
      let dom = 0;
      for (let i = 1; i < 3; i++) if (num(sp[i], 0) > num(sp[dom], 0)) dom = i;

      const n = seasonOf().scale.length;
      const maxIdx = Math.floor(n * 2);
      let idx = Math.round(clamp(num(g.y, 0.5), 0, 1) * maxIdx + rand(-1.4, 1.4));
      if (dom === 2) idx += n; // brighter species an octave up
      idx = clamp(idx, 0, n * 3 - 1);
      const midi = degreeMidi(idx, seasonOf().root + 24);
      const partials = [2.76, 3.0, 4.2];
      const decays = [2.8, 2.2, 1.8];
      note({
        freq: mtof(midi),
        gain: 0.026 * rand(0.7, 1.1),
        decay: decays[dom],
        attack: 0.015,
        pan: (clamp(num(g.x, 0.5), 0, 1) * 2 - 1) * 0.7,
        partial: partials[dom],
        pg: 0.12,
        rev: 0.6,
      });
    },

    pluck(x, y, strength) {
      if (!started || muted) return;
      const now = ctx.currentTime;
      if (now - lastPluck < 0.12) return;
      lastPluck = now;
      const s = clamp(num(strength, 0.5), 0, 1.5);
      const n = seasonOf().scale.length;
      const idx = clamp(Math.floor(clamp(num(x, 0.5), 0, 1) * n * 1.2 + rand(0, 2)), 0, n * 2 - 1);
      const midi = degreeMidi(idx, seasonOf().root + 36);
      note({
        freq: mtof(midi),
        gain: 0.008 + 0.014 * s,
        decay: 3,
        attack: 0.008,
        pan: (clamp(num(x, 0.5), 0, 1) * 2 - 1) * 0.8,
        partial: 3.5,
        pg: 0.2,
        rev: 1.2,
      });
    },

    swell() {
      if (!started || muted) return;
      const now = ctx.currentTime;
      if (now - lastSwell < 2) return;
      lastSwell = now;

      // pad drops a whole step and returns
      for (const v of voices) {
        for (const o of v.oscs) {
          o.osc.detune.setTargetAtTime(o.base - 200, now, 0.9);
          o.osc.detune.setTargetAtTime(o.base, now + 2.6, 1.3);
        }
      }

      if (alive >= MAX_ALIVE - 4) return;
      const dur = 5.5;
      // whoosh
      const src = ctx.createBufferSource();
      src.buffer = noiseBuf;
      src.loop = true;
      const bp = ctx.createBiquadFilter();
      bp.type = 'bandpass';
      bp.Q.value = 0.8;
      bp.frequency.setValueAtTime(300, now);
      bp.frequency.linearRampToValueAtTime(2000, now + 2.4);
      bp.frequency.linearRampToValueAtTime(350, now + dur);
      const wg = ctx.createGain();
      wg.gain.setValueAtTime(0, now);
      wg.gain.linearRampToValueAtTime(0.1, now + 2.4);
      wg.gain.linearRampToValueAtTime(0, now + dur);
      src.connect(bp); bp.connect(wg); wg.connect(bus);
      const rs = ctx.createGain();
      rs.gain.value = 0.7;
      wg.connect(rs); rs.connect(conv);
      alive++;
      src.onended = () => {
        alive = Math.max(0, alive - 1);
        for (const n of [src, bp, wg, rs]) { try { n.disconnect(); } catch (e) { /* ignore */ } }
      };
      src.start(now, rand(0, 2));
      src.stop(now + dur + 0.1);

      // reversed-envelope chord: slow attack, quick release
      const s = seasonOf();
      const offs = [12, 19, 26];
      for (let i = 0; i < offs.length; i++) {
        if (alive >= MAX_ALIVE) break;
        const o = ctx.createOscillator();
        o.type = i === 1 ? 'triangle' : 'sine';
        o.frequency.value = mtof(s.root + offs[i] + 12);
        const g = ctx.createGain();
        g.gain.setValueAtTime(0, now);
        g.gain.linearRampToValueAtTime(0.03, now + 3.2);
        g.gain.linearRampToValueAtTime(0, now + 3.8);
        const p = makePanner(ctx, (i - 1) * 0.5);
        o.connect(g);
        let out = g;
        if (p) { g.connect(p); out = p; }
        out.connect(bus);
        const r = ctx.createGain();
        r.gain.value = 0.8;
        out.connect(r); r.connect(conv);
        alive++;
        o.onended = () => {
          alive = Math.max(0, alive - 1);
          for (const n of [o, g, p, r]) { try { if (n) n.disconnect(); } catch (e) { /* ignore */ } }
        };
        o.start(now);
        o.stop(now + 4);
      }
    },

    bloom(strength) {
      if (!started || muted) return;
      const now = ctx.currentTime;
      const s = clamp(num(strength, 0.5), 0, 1.5);
      const sc = seasonOf();
      // soft sub thump, slow attack so there is no click
      note({
        freq: mtof(sc.root + 12),
        gain: 0.06 + 0.07 * s,
        attack: 0.08,
        decay: 2.2,
        partial: 2,
        pg: 0.15,
        rev: 0.4,
        pan: 0,
        t: now,
      });
      // rising arpeggio
      const n = sc.scale.length;
      const count = 3 + (Math.random() < 0.5 ? 1 : 0);
      const start = Math.floor(rand(0, 2));
      for (let i = 0; i < count; i++) {
        note({
          freq: mtof(degreeMidi(start + i * 2, sc.root + 24)),
          gain: 0.012 + 0.012 * s,
          attack: 0.02,
          decay: 2.2,
          partial: 2.76,
          pg: 0.1,
          rev: 0.8,
          pan: rand(-0.5, 0.5),
          t: now + 0.12 + i * 0.075,
        });
      }
      void n;
    },

    setMuted(m) {
      muted = !!m;
      if (!started) return;
      if (muted) {
        rampMaster(0, 0.4);
      } else {
        if (!document.hidden) { try { ctx.resume().catch(() => {}); } catch (e) { /* ignore */ } }
        rampMaster(MASTER_LEVEL, 0.4);
      }
    },
    get muted() { return muted; },
  };

  return api;
}
