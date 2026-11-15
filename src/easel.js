// Eddy — shared easel client. Talks to the WebSocket relay (see DESIGN.md, "v2: sediment and
// shared easels"): connection lifecycle, encoding, decoding, validation, batching, reconnects.
// Knows nothing about WebGL, the sim or the DOM beyond `location`, `WebSocket` and `crypto`.
// Everything that arrives from the network is untrusted and validated before a handler sees it.

const ID_RE = /^[a-z0-9]{8,32}$/;
const ID_ALPHABET = 'abcdefghijklmnopqrstuvwxyz0123456789';
const ID_LENGTH = 10;

const FLUSH_INTERVAL = 1 / 30;
const MAX_SPLATS = 48;
const MAX_WELLS = 12;
const MAX_BUFFERED = 256 * 1024; // bytes; above this the link is congested, drop the batch
const MAX_JSON_IN = 20000; // chars; the relay caps frames at 16 KB, so anything bigger is bogus
const MAX_SNAP_BYTES = 400000; // the relay's binary frame cap
const SNAP_MAX_DIM = 512;
const MAX_PEERS = 16; // sanity bound on the peer list (the relay allows 6 per room)
const HELLO_TIMEOUT_MS = 8000;
const BACKOFF_S = [1, 2, 4, 8, 15];
const MAX_SEASON = 63;

const KIND_FULL = 1;
const KIND_SYNC = 2;

const isNum = (v) => typeof v === 'number' && Number.isFinite(v);
const clamp01 = (v) => (v < 0 ? 0 : v > 1 ? 1 : v);
const r4 = (v) => Math.round(v * 1e4) / 1e4;
const isPeerId = (v) => Number.isInteger(v) && v >= 1 && v <= 250;

/**
 * The easel id from a path like `/e/<id>` (optional trailing slash), else null.
 * @returns {string | null}
 */
export function easelIdFromLocation() {
  const m = /^\/e\/([^/]+)\/?$/.exec(location.pathname || '');
  return m && ID_RE.test(m[1]) ? m[1] : null;
}

/**
 * Absolute shareable URL for an easel id.
 * @param {string} id
 * @returns {string}
 */
export function linkFor(id) {
  return location.origin + '/e/' + id;
}

/** 10 random chars of a-z0-9, unbiased (bytes >= 252 are rejected; 252 = 7 * 36). */
function randomId() {
  let out = '';
  const buf = new Uint8Array(32);
  while (out.length < ID_LENGTH) {
    crypto.getRandomValues(buf);
    for (let i = 0; i < buf.length && out.length < ID_LENGTH; i++) {
      if (buf[i] < 252) out += ID_ALPHABET[buf[i] % 36];
    }
  }
  return out;
}

/**
 * @typedef {'off' | 'connecting' | 'live' | 'reconnecting' | 'full'} EaselStatus
 *
 * @typedef {object} EaselHandlers  All optional. Each is called inside try/catch.
 * @property {(status: EaselStatus) => void} [onStatus]  Only when the status actually changes.
 * @property {(peers: number[], selfId: number, keeperId: number) => void} [onPeers]
 *   `peers` are the ids of the OTHER people; it is a fresh copy each call.
 * @property {(from: number, x: number, y: number, vx: number, vy: number,
 *   species: number[], radius: number, amount: number) => void} [onSplat]
 *   `species` is ONE reused 3-element array [a, b, c]; the handler must copy it, not keep it.
 * @property {(from: number, x: number, y: number, strength: number, radius: number) => void} [onWell]
 * @property {(from: number, kind: string, data: object) => void} [onEvent]
 *   kind 'tide' {x, y, chirality}, 'season' {index}, 'clear' {scour}, 'state' {season, chirality}.
 * @property {(from: number, kind: 'full' | 'sync',
 *   snap: {w: number, h: number, dye: Uint8Array, bed: Uint8Array}) => void} [onSnapshot]
 *   dye and bed are fresh RGBA arrays (alpha 255), row 0 = bottom, like `sim.capture`.
 * @property {(from: number) => void} [onWant]  Only called while this client is the keeper.
 */

/**
 * Create a relay client. Nothing connects until `create()` or `join()`.
 * @param {EaselHandlers} [handlers]
 */
export function createEasel(handlers = {}) {
  let status = 'off';
  let id = null;
  let selfId = 0;
  let keeperId = 0;
  let peers = [];

  let ws = null;
  let conn = 0; // connection token: bumped on every connect/teardown so stale events are ignored
  let helloTimer = null;
  let retryTimer = null;
  let attempt = 0; // backoff step; reset by a successful hello
  let wantSent = false;
  let gotFull = false;

  let acc = 0;
  const splatQ = [];
  const wellQ = [];
  const spScratch = [0, 0, 0];

  const call = (name, ...args) => {
    const fn = handlers[name];
    if (typeof fn !== 'function') return;
    try {
      fn(...args);
    } catch (err) {
      console.error('easel handler ' + name + ' threw', err);
    }
  };

  const setStatus = (s) => {
    if (s === status) return;
    status = s;
    call('onStatus', s);
  };

  const emitPeers = () => call('onPeers', peers.slice(), selfId, keeperId);

  const clearRoomState = () => {
    peers = [];
    selfId = 0;
    keeperId = 0;
    wantSent = false;
    gotFull = false;
    splatQ.length = 0;
    wellQ.length = 0;
    acc = 0;
    emitPeers();
  };

  const clearTimers = () => {
    if (helloTimer !== null) clearTimeout(helloTimer);
    if (retryTimer !== null) clearTimeout(retryTimer);
    helloTimer = null;
    retryTimer = null;
  };

  /** Drop the current socket without letting any of its events through. */
  const detach = () => {
    conn++;
    const old = ws;
    ws = null;
    if (helloTimer !== null) clearTimeout(helloTimer);
    helloTimer = null;
    if (old) {
      old.onopen = old.onmessage = old.onclose = old.onerror = null;
      try {
        old.close();
      } catch {
        /* already closed */
      }
    }
  };

  const live = () => status === 'live' && ws !== null && ws.readyState === 1;

  // -- connecting -------------------------------------------------------------------------

  const scheduleRetry = () => {
    if (retryTimer !== null) clearTimeout(retryTimer);
    const delay = BACKOFF_S[Math.min(attempt, BACKOFF_S.length - 1)] * 1000;
    attempt++;
    retryTimer = setTimeout(() => {
      retryTimer = null;
      connect();
    }, delay);
  };

  /** A connection attempt or live connection ended without being asked to. */
  const failed = () => {
    detach();
    clearRoomState();
    setStatus('reconnecting');
    scheduleRetry();
  };

  const connect = () => {
    if (id === null) return;
    if (retryTimer !== null) clearTimeout(retryTimer);
    retryTimer = null;
    detach();
    const token = conn; // detach() bumped it; this is the token for the new socket
    if (status !== 'reconnecting') setStatus('connecting');
    let sock;
    try {
      const proto = location.protocol === 'https:' ? 'wss://' : 'ws://';
      sock = new WebSocket(proto + location.host + '/ws/' + id);
      sock.binaryType = 'arraybuffer';
    } catch {
      failed();
      return;
    }
    ws = sock;
    wantSent = false;
    gotFull = false;
    helloTimer = setTimeout(() => {
      helloTimer = null;
      if (token === conn) failed(); // no hello in time: a failed attempt
    }, HELLO_TIMEOUT_MS);
    sock.onmessage = (ev) => {
      if (token === conn) onMessage(ev.data);
    };
    sock.onclose = (ev) => {
      if (token === conn) onClose(ev && ev.code);
    };
    sock.onerror = () => {
      /* a close event follows; nothing to do */
    };
  };

  const onClose = (code) => {
    if (code === 4001 || (Number.isInteger(code) && code >= 4000 && code <= 4099)) {
      // The server refused us for good: no retry.
      detach();
      clearTimers();
      clearRoomState();
      setStatus(code === 4001 ? 'full' : 'off');
      return;
    }
    failed();
  };

  // -- receiving --------------------------------------------------------------------------

  const onMessage = (data) => {
    if (typeof data === 'string') {
      if (data.length > MAX_JSON_IN) return;
      let msg;
      try {
        msg = JSON.parse(data);
      } catch {
        return;
      }
      if (msg === null || typeof msg !== 'object' || Array.isArray(msg)) return;
      onJson(msg);
    } else if (data instanceof ArrayBuffer) {
      onBinary(data);
    }
  };

  const onJson = (msg) => {
    const t = msg.t;
    if (t === 'hello') return onHello(msg);
    if (t === 'join') return onJoin(msg);
    if (t === 'leave') return onLeave(msg);
    if (status !== 'live') return;
    const from = msg.from;
    if (!isPeerId(from) || peers.indexOf(from) < 0) return;
    if (t === 'f') return onFrame(from, msg);
    if (t === 'ev') return onEv(from, msg);
    if (t === 'want') {
      if (selfId !== 0 && keeperId === selfId) call('onWant', from);
    }
  };

  const onHello = (msg) => {
    if (status === 'live') return; // one hello per connection
    if (!isPeerId(msg.id)) return;
    const list = [];
    if (Array.isArray(msg.peers)) {
      for (let i = 0; i < msg.peers.length && list.length < MAX_PEERS; i++) {
        const p = msg.peers[i];
        if (isPeerId(p) && p !== msg.id && list.indexOf(p) < 0) list.push(p);
      }
    }
    selfId = msg.id;
    peers = list;
    keeperId = isPeerId(msg.keeper) ? msg.keeper : selfId;
    attempt = 0;
    if (helloTimer !== null) clearTimeout(helloTimer);
    helloTimer = null;
    setStatus('live');
    emitPeers();
    if (peers.length > 0 && !wantSent) {
      wantSent = true;
      sendRaw('{"t":"want"}');
    }
  };

  const onJoin = (msg) => {
    if (status !== 'live' || !isPeerId(msg.id) || msg.id === selfId) return;
    if (peers.indexOf(msg.id) >= 0 || peers.length >= MAX_PEERS) return;
    peers.push(msg.id);
    emitPeers();
  };

  const onLeave = (msg) => {
    if (status !== 'live' || !isPeerId(msg.id)) return;
    const i = peers.indexOf(msg.id);
    if (i < 0) return;
    peers.splice(i, 1);
    if (isPeerId(msg.keeper)) keeperId = msg.keeper;
    emitPeers();
  };

  const onFrame = (from, msg) => {
    const s = msg.s;
    if (Array.isArray(s)) {
      const n = Math.min(s.length, MAX_SPLATS);
      for (let i = 0; i < n; i++) {
        const a = s[i];
        if (!Array.isArray(a) || a.length < 9) continue;
        const x = a[0], y = a[1], vx = a[2], vy = a[3];
        const sa = a[4], sb = a[5], sc = a[6], r = a[7], amt = a[8];
        if (!isNum(x) || !isNum(y) || !isNum(vx) || !isNum(vy)) continue;
        if (!isNum(sa) || !isNum(sb) || !isNum(sc) || !isNum(r) || !isNum(amt)) continue;
        if (Math.abs(vx) > 8 || Math.abs(vy) > 8) continue;
        if (sa < 0 || sa > 1 || sb < 0 || sb > 1 || sc < 0 || sc > 1) continue;
        if (r < 0.001 || r > 0.5 || amt < 0 || amt > 1.5) continue;
        spScratch[0] = sa;
        spScratch[1] = sb;
        spScratch[2] = sc;
        // optional 10th entry: 1 = "quiet" (autopilot ink, not a person's hand)
        call('onSplat', from, clamp01(x), clamp01(y), vx, vy, spScratch, r, amt, a[9] === 1);
      }
    }
    const w = msg.w;
    if (Array.isArray(w)) {
      const n = Math.min(w.length, MAX_WELLS);
      for (let i = 0; i < n; i++) {
        const a = w[i];
        if (!Array.isArray(a) || a.length < 4) continue;
        const x = a[0], y = a[1], str = a[2], r = a[3];
        if (!isNum(x) || !isNum(y) || !isNum(str) || !isNum(r)) continue;
        if (Math.abs(str) > 8 || r < 0.001 || r > 0.5) continue;
        call('onWell', from, clamp01(x), clamp01(y), str, r);
      }
    }
  };

  const onEv = (from, msg) => {
    const k = msg.k;
    const d = msg.d;
    if (typeof k !== 'string' || d === null || typeof d !== 'object') return;
    if (k === 'tide') {
      if (!isNum(d.x) || !isNum(d.y)) return;
      const chirality = isNum(d.chirality) && d.chirality < 0 ? -1 : 1;
      call('onEvent', from, 'tide', { x: clamp01(d.x), y: clamp01(d.y), chirality });
    } else if (k === 'season') {
      const index = intIn(d.index, 0, MAX_SEASON);
      if (index < 0) return;
      call('onEvent', from, 'season', { index });
    } else if (k === 'clear') {
      call('onEvent', from, 'clear', { scour: d.scour === true });
    } else if (k === 'state') {
      const season = intIn(d.season, 0, MAX_SEASON);
      if (season < 0) return;
      const chirality = isNum(d.chirality) && d.chirality < 0 ? -1 : 1;
      call('onEvent', from, 'state', { season, chirality });
    }
  };

  /** Round a finite number to an integer in [lo, hi]; -1 if invalid. */
  function intIn(v, lo, hi) {
    if (!isNum(v)) return -1;
    const n = Math.round(v);
    return n >= lo && n <= hi ? n : -1;
  }

  const onBinary = (buf) => {
    if (status !== 'live' || buf.byteLength < 8) return;
    const dv = new DataView(buf);
    const k = dv.getUint8(0);
    if (k !== KIND_FULL && k !== KIND_SYNC) return;
    const from = dv.getUint8(1);
    if (!isPeerId(from) || peers.indexOf(from) < 0) return;
    if (k === KIND_SYNC && from !== keeperId) return;
    if (k === KIND_FULL && (!wantSent || gotFull)) return;
    const w = dv.getUint16(2, true);
    const h = dv.getUint16(4, true);
    if (w < 1 || w > SNAP_MAX_DIM || h < 1 || h > SNAP_MAX_DIM) return;
    const n = w * h;
    if (buf.byteLength !== 8 + 6 * n) return;
    const src = new Uint8Array(buf);
    const dye = new Uint8Array(n * 4);
    const bed = new Uint8Array(n * 4);
    const dyeOff = 8;
    const bedOff = 8 + 3 * n;
    for (let i = 0, p = 0, q = 0; i < n; i++, p += 3, q += 4) {
      dye[q] = src[dyeOff + p];
      dye[q + 1] = src[dyeOff + p + 1];
      dye[q + 2] = src[dyeOff + p + 2];
      dye[q + 3] = 255;
      bed[q] = src[bedOff + p];
      bed[q + 1] = src[bedOff + p + 1];
      bed[q + 2] = src[bedOff + p + 2];
      bed[q + 3] = 255;
    }
    if (k === KIND_FULL) gotFull = true;
    call('onSnapshot', from, k === KIND_FULL ? 'full' : 'sync', { w, h, dye, bed });
  };

  // -- sending ----------------------------------------------------------------------------

  const sendRaw = (str) => {
    if (!ws || ws.readyState !== 1) return false;
    try {
      ws.send(str);
      return true;
    } catch {
      return false;
    }
  };

  const flush = () => {
    const s = splatQ.splice(0, splatQ.length);
    const w = wellQ.splice(0, wellQ.length);
    if (ws.bufferedAmount > MAX_BUFFERED) return; // congested: drop this batch
    const msg = { t: 'f' };
    if (s.length) msg.s = s.slice(-MAX_SPLATS);
    if (w.length) msg.w = w.slice(-MAX_WELLS);
    sendRaw(JSON.stringify(msg));
  };

  // -- reconnect triggers -----------------------------------------------------------------

  const retryNow = () => {
    if (retryTimer !== null && status === 'reconnecting') connect();
  };
  if (typeof document !== 'undefined' && document.addEventListener) {
    document.addEventListener('visibilitychange', () => {
      if (document.visibilityState === 'visible') retryNow();
    });
  }
  if (typeof globalThis.addEventListener === 'function') {
    globalThis.addEventListener('online', retryNow);
  }

  // -- public API -------------------------------------------------------------------------

  const easel = {
    /** Current easel id, or null. */
    get id() { return id; },
    /** @type {EaselStatus} */
    get status() { return status; },
    /** This client's peer id (0 when not live). */
    get selfId() { return selfId; },
    /** Peer id of the keeper (0 when not live). */
    get keeperId() { return keeperId; },
    /** True only when live and this client is the keeper. */
    get isKeeper() { return status === 'live' && selfId !== 0 && keeperId === selfId; },
    /** Ids of the other people here (a copy). */
    get peers() { return peers.slice(); },

    /**
     * Make a new random easel id (10 chars, a-z0-9), join it and return it.
     * @returns {string}
     */
    create() {
      const nid = randomId();
      easel.join(nid);
      return nid;
    },

    /**
     * Connect to an easel, leaving any other one first. Returns false for an invalid id.
     * Joining the easel already in use is a no-op unless it is off or full.
     * @param {string} nid
     * @returns {boolean}
     */
    join(nid) {
      if (typeof nid !== 'string' || !ID_RE.test(nid)) return false;
      if (id === nid && status !== 'off' && status !== 'full') return true;
      if (id !== null) easel.leave();
      id = nid;
      attempt = 0;
      connect();
      return true;
    },

    /** Disconnect on purpose: no reconnect, status 'off'. */
    leave() {
      detach();
      clearTimers();
      attempt = 0;
      id = null;
      clearRoomState();
      setStatus('off');
    },

    /**
     * Queue a splat for the next flush (no-op unless live). Values are clamped to the ranges
     * receivers accept; if more than 48 are queued between flushes the oldest are dropped.
     */
    splat(x, y, vx, vy, species, radius, amount, quiet) {
      if (status !== 'live') return;
      const sp = species || spScratch;
      const f = (v) => (isNum(v) ? v : 0);
      const cl = (v, lo, hi) => (v < lo ? lo : v > hi ? hi : v);
      if (splatQ.length >= MAX_SPLATS) splatQ.shift();
      splatQ.push([
        r4(clamp01(f(x))), r4(clamp01(f(y))),
        r4(cl(f(vx), -8, 8)), r4(cl(f(vy), -8, 8)),
        r4(clamp01(f(sp[0]))), r4(clamp01(f(sp[1]))), r4(clamp01(f(sp[2]))),
        r4(cl(f(radius), 0.001, 0.5)), r4(cl(f(amount), 0, 1.5)),
      ]);
      if (quiet) splatQ[splatQ.length - 1].push(1);
    },

    /** Queue a well for the next flush (no-op unless live). Oldest dropped beyond 12. */
    well(x, y, strength, radius) {
      if (status !== 'live') return;
      const f = (v) => (isNum(v) ? v : 0);
      const cl = (v, lo, hi) => (v < lo ? lo : v > hi ? hi : v);
      if (wellQ.length >= MAX_WELLS) wellQ.shift();
      wellQ.push([
        r4(clamp01(f(x))), r4(clamp01(f(y))),
        r4(cl(f(strength), -8, 8)), r4(cl(f(radius), 0.001, 0.5)),
      ]);
    },

    /**
     * Send an event now (no-op unless live): {"t":"ev","k":kind,"d":data}.
     * @param {'tide' | 'season' | 'clear' | 'state'} kind
     * @param {object} data
     */
    send(kind, data) {
      if (!live()) return;
      sendRaw(JSON.stringify({ t: 'ev', k: kind, d: data }));
    },

    /**
     * Send a snapshot (no-op unless live). `snap` is {w, h, dye, bed} with RGBA arrays as from
     * `sim.capture`; alpha is dropped on the wire. `to` = 0 for everyone, else a peer id.
     * Refused (returns false) if the arrays are the wrong size, w/h are outside 1..512, or the
     * frame would exceed the relay's 400 KB limit. A 'sync' is also dropped when congested.
     * @param {'full' | 'sync'} kind
     * @param {{w: number, h: number, dye: Uint8Array, bed: Uint8Array}} snap
     * @param {number} [to]
     * @returns {boolean}
     */
    sendSnapshot(kind, snap, to = 0) {
      if (!live() || !snap) return false;
      const k = kind === 'full' ? KIND_FULL : kind === 'sync' ? KIND_SYNC : 0;
      if (!k) return false;
      const { w, h, dye, bed } = snap;
      if (!Number.isInteger(w) || !Number.isInteger(h)) return false;
      if (w < 1 || w > SNAP_MAX_DIM || h < 1 || h > SNAP_MAX_DIM) return false;
      const n = w * h;
      if (!dye || !bed || dye.length !== n * 4 || bed.length !== n * 4) return false;
      if (8 + 6 * n > MAX_SNAP_BYTES) return false;
      if (k === KIND_SYNC && ws.bufferedAmount > MAX_BUFFERED) return false;
      const out = new Uint8Array(8 + 6 * n);
      out[0] = k;
      out[1] = Number.isInteger(to) && to >= 0 && to <= 255 ? to : 0;
      out[2] = w & 255;
      out[3] = w >> 8;
      out[4] = h & 255;
      out[5] = h >> 8;
      // bytes 6 and 7 stay zero
      const bedOff = 8 + 3 * n;
      for (let i = 0, p = 0, q = 0; i < n; i++, p += 3, q += 4) {
        out[8 + p] = dye[q];
        out[8 + p + 1] = dye[q + 1];
        out[8 + p + 2] = dye[q + 2];
        out[bedOff + p] = bed[q];
        out[bedOff + p + 1] = bed[q + 1];
        out[bedOff + p + 2] = bed[q + 2];
      }
      try {
        ws.send(out.buffer);
        return true;
      } catch {
        return false;
      }
    },

    /**
     * Call every frame. Flushes queued splats/wells at most every 1/30 s while live.
     * @param {number} dt seconds since the last call
     */
    update(dt) {
      if (status !== 'live') return;
      acc += isNum(dt) && dt > 0 ? dt : 0;
      if (acc > FLUSH_INTERVAL) acc = FLUSH_INTERVAL;
      if (acc < FLUSH_INTERVAL) return;
      if (splatQ.length === 0 && wellQ.length === 0) return; // stay primed for the next gesture
      acc = 0;
      if (live()) flush();
    },
  };

  return easel;
}
