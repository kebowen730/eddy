// Eddy relay: tiny WebSocket rooms. Clients with the same easel id (/ws/<id>) hear each
// other's messages. The server keeps no easel state; it only forwards and enforces limits.
// Everything a client sends is hostile: sizes are capped, parsing is guarded, and nothing a
// client sends is ever used as a key on a live object.
import { WebSocketServer, WebSocket } from 'ws';

const MAX_PEERS = 6;
const MAX_ROOMS = 500;
const MAX_JSON = 16 * 1024;       // text frame limit (ws maxPayload allows binary up to 400 KB)
const MAX_BUFFERED = 2 * 1024 * 1024; // skip slow recipients instead of queueing more
const RATE = 90, BURST = 180;     // token bucket: messages/s, burst
const RATE_GRACE_MS = 5000;       // still over the limit after this long -> close 4008
const PING_MS = 25000;
const RESERVED = new Set(['hello', 'join', 'leave']);
const ID_RE = /^[a-z0-9]{8,32}$/;

export function attachRelay(httpServer, opts = {}) {
  const rooms = new Map(); // easel id -> Map(peerId -> ws); Map order = connect order
  const wss = new WebSocketServer({ noServer: true, maxPayload: 400 * 1024, perMessageDeflate: false });

  const sendJSON = (ws, obj) => {
    if (ws.readyState === WebSocket.OPEN) ws.send(JSON.stringify(obj));
  };
  const keeperOf = (room) => room.keys().next().value; // longest-connected = first inserted

  function originOk(req) {
    if (opts.allowAnyOrigin) return true;
    try {
      const host = new URL(req.headers.origin).host.toLowerCase();
      return host === String(req.headers.host || '').toLowerCase();
    } catch { return false; }
  }

  function onUpgrade(req, socket, head) {
    let path;
    try { path = new URL(req.url, 'http://x').pathname; } catch { return; }
    if (!path.startsWith('/ws/') || path.length === 4) return; // not ours (e.g. Vite HMR)
    socket.on('error', () => {});
    const id = path.slice(4);
    wss.handleUpgrade(req, socket, head, (ws) => {
      ws.on('error', () => {});
      // Complete the handshake first so the browser can read the close code.
      if (!ID_RE.test(id)) return ws.close(4000, 'bad id');
      if (!originOk(req)) return ws.close(4003, 'bad origin');
      let room = rooms.get(id);
      if (!room && rooms.size >= MAX_ROOMS) return ws.close(4001, 'busy');
      if (room && room.size >= MAX_PEERS) return ws.close(4001, 'full');
      if (!room) {
        room = new Map();
        rooms.set(id, room);
        console.log(`[relay] room ${id.slice(0, 3)}… created (${rooms.size} rooms)`);
      }
      join(ws, id, room);
    });
  }

  function join(ws, easelId, room) {
    let me = 1;
    while (room.has(me)) me++; // at most 6 peers, so this is always <= 7
    const others = [...room.keys()];
    room.set(me, ws);
    ws.isAlive = true;
    ws.on('pong', () => { ws.isAlive = true; });
    sendJSON(ws, { t: 'hello', id: me, peers: others, keeper: keeperOf(room) });
    for (const p of others) sendJSON(room.get(p), { t: 'join', id: me });

    let tokens = BURST, last = Date.now(), overSince = 0;
    ws.on('message', (data, isBinary) => {
      try {
        const now = Date.now();
        tokens = Math.min(BURST, tokens + (now - last) * RATE / 1000);
        last = now;
        if (tokens < 1) {
          if (!overSince) overSince = now;
          else if (now - overSince > RATE_GRACE_MS) ws.close(4008, 'rate');
          return;
        }
        tokens -= 1;
        if (tokens > BURST / 2) overSince = 0; // recovered
        const buf = Buffer.isBuffer(data) ? data : Buffer.concat([].concat(data));
        if (isBinary) relayBinary(room, me, buf);
        else relayText(room, me, buf);
      } catch { /* one bad frame never takes the process down */ }
    });
    ws.on('close', () => {
      if (room.get(me) !== ws) return;
      room.delete(me);
      if (room.size === 0) {
        rooms.delete(easelId);
        console.log(`[relay] room ${easelId.slice(0, 3)}… destroyed (${rooms.size} rooms)`);
        return;
      }
      const msg = JSON.stringify({ t: 'leave', id: me, keeper: keeperOf(room) });
      for (const peer of room.values()) deliver(peer, msg);
    });
  }

  function deliver(peer, payload) {
    if (peer.readyState !== WebSocket.OPEN || peer.bufferedAmount > MAX_BUFFERED) return;
    peer.send(payload);
  }

  function relayText(room, me, buf) {
    if (buf.length > MAX_JSON) return;
    let msg;
    try { msg = JSON.parse(buf.toString('utf8')); } catch { return; }
    if (!msg || typeof msg !== 'object' || Array.isArray(msg)) return;
    const t = msg.t;
    if (typeof t !== 'string' || t.length < 1 || t.length > 12 || RESERVED.has(t)) return;
    // Null-prototype copy: a client key like "__proto__" becomes a plain property, not a setter.
    const out = Object.create(null);
    for (const k of Object.keys(msg)) if (k !== 'to' && k !== 'from') out[k] = msg[k];
    out.from = me;
    const payload = JSON.stringify(out);
    const to = msg.to;
    if (typeof to === 'number') {
      const peer = room.get(to);
      if (peer && to !== me) deliver(peer, payload);
    } else {
      for (const [id, peer] of room) if (id !== me) deliver(peer, payload);
    }
  }

  function relayBinary(room, me, buf) {
    if (buf.length < 8) return;
    const to = buf[1];
    const out = Buffer.from(buf); // copy: never mutate the buffer ws owns
    out[1] = me;
    if (to === 0) {
      for (const [id, peer] of room) if (id !== me) deliver(peer, out);
    } else {
      const peer = room.get(to);
      if (peer && to !== me) deliver(peer, out);
    }
  }

  const heartbeat = setInterval(() => {
    for (const ws of wss.clients) {
      if (ws.isAlive === false) { ws.terminate(); continue; }
      ws.isAlive = false;
      try { ws.ping(); } catch { /* socket already going away */ }
    }
  }, PING_MS);
  heartbeat.unref();

  httpServer.on('upgrade', onUpgrade);

  return {
    get rooms() { return rooms.size; },
    close() {
      clearInterval(heartbeat);
      httpServer.off('upgrade', onUpgrade);
      for (const ws of wss.clients) ws.terminate();
      wss.close();
    },
  };
}
