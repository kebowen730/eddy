// Dependency-free checks for the static server and relay. Run: node server/test.mjs
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import http from 'node:http';
import zlib from 'node:zlib';
import WebSocket from 'ws';
import { createServer } from './index.js';

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'eddy-test-'));
fs.mkdirSync(path.join(tmp, 'assets'));
fs.writeFileSync(path.join(tmp, 'index.html'), '<!doctype html><title>fake</title>');
fs.writeFileSync(path.join(tmp, 'assets', 'app.js'), 'console.log("hi");\n'.repeat(100));

let failed = 0;
async function check(name, fn) {
  try { await fn(); console.log(`ok   ${name}`); }
  catch (e) { failed++; console.log(`FAIL ${name}\n     ${e.stack.split('\n').slice(0, 3).join('\n     ')}`); }
}
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const listen = (s) => new Promise((r) => s.listen(0, '127.0.0.1', () => r(s.address().port)));

// Raw request so we can send odd paths without client-side normalisation.
function req(port, p, { method = 'GET', headers = {} } = {}) {
  return new Promise((resolve, reject) => {
    const r = http.request({ host: '127.0.0.1', port, path: p, method, headers }, (res) => {
      const chunks = [];
      res.on('data', (c) => chunks.push(c));
      res.on('end', () => resolve({ status: res.statusCode, headers: res.headers, body: Buffer.concat(chunks) }));
    });
    r.on('error', reject);
    r.end();
  });
}

// A ws client that records everything it receives and how it closed.
function client(port, id, opts = {}) {
  const ws = new WebSocket(`ws://127.0.0.1:${port}/ws/${id}`, opts);
  const c = { ws, msgs: [], bins: [], closed: null };
  ws.on('message', (d, isBin) => (isBin ? c.bins.push(Buffer.from(d)) : c.msgs.push(JSON.parse(d.toString()))));
  ws.on('close', (code) => { c.closed = code; });
  ws.on('error', () => {});
  c.open = new Promise((r) => ws.on('open', r));
  c.waitClose = async () => { for (let i = 0; i < 100 && c.closed === null; i++) await sleep(20); return c.closed; };
  c.hello = async () => { for (let i = 0; i < 100 && !c.msgs.length; i++) await sleep(20); return c.msgs[0]; };
  return c;
}
const settle = () => sleep(120);

const app = createServer({ distDir: tmp, relayOpts: { allowAnyOrigin: true } });
const port = await listen(app.server);
const strict = createServer({ distDir: tmp }); // origin check on
const strictPort = await listen(strict.server);
const all = [];
const mk = (p, id, o) => { const c = client(p, id, o); all.push(c); return c; };

await check('static: healthz, index, assets, fallback, 404, 405, traversal', async () => {
  let r = await req(port, '/healthz');
  assert.equal(r.status, 200); assert.equal(r.body.toString(), 'ok\n');
  r = await req(port, '/');
  assert.equal(r.status, 200); assert.match(r.body.toString(), /fake/);
  assert.equal(r.headers['cache-control'], 'no-cache');
  assert.equal(r.headers['x-content-type-options'], 'nosniff');
  assert.equal(r.headers['referrer-policy'], 'no-referrer');
  r = await req(port, '/assets/app.js', { headers: { 'accept-encoding': 'gzip' } });
  assert.match(r.headers['cache-control'], /immutable/);
  assert.equal(r.headers['content-encoding'], 'gzip');
  assert.match(zlib.gunzipSync(r.body).toString(), /console\.log/);
  r = await req(port, '/assets/app.js');
  assert.equal(r.headers['content-encoding'], undefined);
  r = await req(port, '/e/abcdefgh12');
  assert.equal(r.status, 200); assert.match(r.body.toString(), /fake/);
  assert.equal((await req(port, '/nope.js')).status, 404);
  assert.equal((await req(port, '/', { method: 'POST' })).status, 405);
  r = await req(port, '/..%2f..%2fetc/passwd');
  assert.ok(r.status === 200 && /fake/.test(r.body.toString()) || r.status === 404);
  assert.ok(!/root:/.test(r.body.toString()));
  r = await req(port, '/../../etc/passwd.txt');
  assert.equal(r.status, 404);
  assert.equal((await req(port, '/%E0%A4%A')).status, 400);
});

const A = mk(port, 'roomaaaa11'), B = mk(port, 'roomaaaa11');
await check('join: hello, peers, keeper, join notice', async () => {
  const ha = await A.hello();
  assert.deepEqual(ha, { t: 'hello', id: ha.id, peers: [], keeper: ha.id });
  const hb = await B.hello();
  assert.deepEqual(hb.peers, [ha.id]); assert.equal(hb.keeper, ha.id); assert.notEqual(hb.id, ha.id);
  await settle();
  assert.deepEqual(A.msgs[1], { t: 'join', id: hb.id });
});

const idA = (await A.hello()).id, idB = (await B.hello()).id;
await check('json relay: from, to, drops', async () => {
  A.msgs.length = B.msgs.length = 0;
  A.ws.send(JSON.stringify({ t: 'f', s: [[1, 2]] }));
  await settle();
  assert.deepEqual(B.msgs, [{ t: 'f', s: [[1, 2]], from: idA }]);
  assert.equal(A.msgs.length, 0);
  B.msgs.length = 0;
  A.ws.send(JSON.stringify({ t: 'ev', to: idB, from: 99, k: 'x' }));
  await settle();
  assert.deepEqual(B.msgs, [{ t: 'ev', k: 'x', from: idA }]);
  B.msgs.length = 0;
  for (const bad of [{ t: 'hello' }, { t: 'join' }, { t: 'leave' }, { x: 1 }, { t: '' }, { t: 'abcdefghijklm' },
    { t: 5 }, [1], 'str', 7, null]) A.ws.send(JSON.stringify(bad));
  A.ws.send('{not json');
  A.ws.send('{"t":"p","__proto__":{"polluted":1}}'); // allowed, but must not pollute
  await settle();
  assert.equal(B.msgs.length, 1);
  assert.equal(B.msgs[0].t, 'p'); assert.equal(B.msgs[0].from, idA);
  assert.equal({}.polluted, undefined);
});

await check('binary relay: broadcast, targeted, short dropped', async () => {
  B.bins.length = A.bins.length = 0;
  A.ws.send(Buffer.from([1, 0, 9, 9, 9, 9, 9, 9]));
  await settle();
  assert.equal(B.bins.length, 1); assert.equal(A.bins.length, 0);
  assert.deepEqual([...B.bins[0]], [1, idA, 9, 9, 9, 9, 9, 9]);
  B.bins.length = 0;
  A.ws.send(Buffer.from([2, idB, 7, 7, 7, 7, 7, 7, 7]));
  A.ws.send(Buffer.from([2, 77, 7, 7, 7, 7, 7, 7])); // nobody with that id
  A.ws.send(Buffer.from([1, 0, 1]));                   // too short
  await settle();
  assert.equal(B.bins.length, 1); assert.equal(B.bins[0][1], idA);
});

await check('oversized text frame dropped, connection survives', async () => {
  B.msgs.length = 0;
  A.ws.send(JSON.stringify({ t: 'big', pad: 'x'.repeat(17 * 1024) }));
  await settle();
  assert.equal(B.msgs.length, 0);
  assert.equal(A.ws.readyState, WebSocket.OPEN);
  A.ws.send(JSON.stringify({ t: 'ok' }));
  await settle();
  assert.equal(B.msgs.length, 1);
  assert.equal((await req(port, '/healthz')).status, 200);
});

await check('different easels are isolated', async () => {
  const C = mk(port, 'roombbbb22'); await C.hello();
  B.msgs.length = 0; C.msgs.length = 0;
  A.ws.send(JSON.stringify({ t: 'f' }));
  C.ws.send(JSON.stringify({ t: 'f' }));
  await settle();
  assert.equal(C.msgs.filter((m) => m.t === 'f').length, 0);
  assert.equal(B.msgs.filter((m) => m.t === 'f').length, 1);
  assert.equal(app.relay.rooms, 2);
  C.ws.close(); await C.waitClose(); await settle();
  assert.equal(app.relay.rooms, 1);
});

await check('keeper handover on leave', async () => {
  const C = mk(port, 'roomaaaa11'); const hc = await C.hello();
  assert.equal(hc.keeper, idA);
  B.msgs.length = C.msgs.length = 0;
  A.ws.close(); await A.waitClose(); await settle();
  assert.deepEqual(B.msgs, [{ t: 'leave', id: idA, keeper: idB }]);
  assert.deepEqual(C.msgs, [{ t: 'leave', id: idA, keeper: idB }]);
});

await check('room full closes the 7th with 4001', async () => {
  const cs = [];
  for (let i = 0; i < 6; i++) { const c = mk(port, 'roomfull99'); cs.push(c); await c.hello(); }
  const seventh = mk(port, 'roomfull99');
  assert.equal(await seventh.waitClose(), 4001);
  assert.equal(cs[0].closed, null);
});

await check('bad id closes 4000', async () => {
  assert.equal(await mk(port, 'SHORT').waitClose(), 4000);
  assert.equal(await mk(port, 'UPPERCASE12345').waitClose(), 4000);
});

await check('origin: wrong 4003, missing 4003, matching ok', async () => {
  assert.equal(await mk(strictPort, 'roomorig11', { origin: 'http://evil.example' }).waitClose(), 4003);
  assert.equal(await mk(strictPort, 'roomorig11').waitClose(), 4003);
  const good = mk(strictPort, 'roomorig11', { origin: `http://127.0.0.1:${strictPort}` });
  assert.equal((await good.hello()).t, 'hello');
});

await check('non-/ws upgrade paths are left alone', async () => {
  // The relay must not answer or close it (Vite's HMR handler owns such upgrades in dev).
  const w = new WebSocket(`ws://127.0.0.1:${port}/other`);
  let opened = false, closed = false;
  w.on('error', () => {}); w.on('open', () => { opened = true; }); w.on('close', () => { closed = true; });
  await sleep(250);
  assert.ok(!opened && !closed);
  w.terminate();
});

await check('rooms removed when empty', async () => {
  for (const c of all) c.ws.terminate();
  for (let i = 0; i < 50 && (app.relay.rooms || strict.relay.rooms); i++) await sleep(20);
  assert.equal(app.relay.rooms, 0); assert.equal(strict.relay.rooms, 0);
});

for (const a of [app, strict]) { a.relay.close(); a.server.close(); a.server.closeAllConnections?.(); }
fs.rmSync(tmp, { recursive: true, force: true });
console.log(failed ? `\n${failed} check(s) failed` : '\nall checks passed');
process.exit(failed ? 1 : 0);
