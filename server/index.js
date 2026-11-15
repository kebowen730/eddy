// Eddy server: serves the built site from memory and hosts the relay on the same port.
// Only built-in modules (plus ws via relay.js). Requests never touch the filesystem, so
// there is nothing to traverse: a path either is a key in the map or it is not.
import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import zlib from 'node:zlib';
import { createHash } from 'node:crypto';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { attachRelay } from './relay.js';

const TYPES = {
  html: 'text/html; charset=utf-8', js: 'text/javascript; charset=utf-8',
  mjs: 'text/javascript; charset=utf-8', css: 'text/css; charset=utf-8',
  svg: 'image/svg+xml', json: 'application/json; charset=utf-8', png: 'image/png',
  jpg: 'image/jpeg', webp: 'image/webp', ico: 'image/x-icon', woff2: 'font/woff2',
  txt: 'text/plain; charset=utf-8', map: 'application/json; charset=utf-8',
  webmanifest: 'application/manifest+json',
};
const TEXT = new Set(['html', 'js', 'mjs', 'css', 'svg', 'json', 'txt', 'map', 'webmanifest']);
const SECURITY = { 'X-Content-Type-Options': 'nosniff', 'Referrer-Policy': 'no-referrer' };

// Read every file under dir into a Map keyed by URL path ("/assets/app.js").
function loadSite(dir) {
  const files = new Map();
  const walk = (d, prefix) => {
    for (const ent of fs.readdirSync(d, { withFileTypes: true })) {
      const full = path.join(d, ent.name);
      if (ent.isDirectory()) { walk(full, `${prefix}${ent.name}/`); continue; }
      if (!ent.isFile()) continue;
      const ext = ent.name.split('.').pop().toLowerCase();
      const type = TYPES[ext];
      if (!type) continue;
      const body = fs.readFileSync(full);
      const gz = TEXT.has(ext) && body.length > 256 ? zlib.gzipSync(body, { level: 9 }) : null;
      const etag = '"' + createHash('sha1').update(body).digest('base64url').slice(0, 16) + '"';
      files.set(`/${prefix}${ent.name}`, { type, body, gz, etag, immutable: prefix.startsWith('assets/') });
    }
  };
  if (fs.existsSync(dir)) walk(dir, '');
  return files;
}

export function createServer({ distDir, relayOpts } = {}) {
  const dir = distDir || fileURLToPath(new URL('../dist/', import.meta.url));
  const files = loadSite(dir);

  const server = http.createServer((req, res) => {
    const send = (code, headers, body) => {
      res.writeHead(code, { ...SECURITY, ...headers });
      res.end(req.method === 'HEAD' ? undefined : body);
    };
    if (req.method !== 'GET' && req.method !== 'HEAD') {
      return send(405, { Allow: 'GET, HEAD', 'Content-Type': 'text/plain' }, 'method not allowed\n');
    }
    let p;
    try { p = decodeURIComponent(new URL(req.url, 'http://x').pathname); }
    catch { return send(400, { 'Content-Type': 'text/plain' }, 'bad request\n'); }

    if (p === '/healthz') return send(200, { 'Content-Type': 'text/plain', 'Cache-Control': 'no-cache' }, 'ok\n');

    let file = files.get(p);
    if (p === '/') file = files.get('/index.html');
    // Extensionless unknown path: the client reads /e/<id> itself, so serve the app.
    else if (!file && !path.posix.basename(p).includes('.')) file = files.get('/index.html');
    if (!file) return send(404, { 'Content-Type': 'text/plain' }, 'not found\n');

    const headers = {
      'Content-Type': file.type,
      'Cache-Control': file.immutable ? 'public, max-age=31536000, immutable' : 'no-cache',
      ETag: file.etag,
    };
    if (file.gz) headers.Vary = 'Accept-Encoding';
    if (req.headers['if-none-match'] === file.etag) return send(304, headers);
    if (file.gz && /\bgzip\b/.test(req.headers['accept-encoding'] || '')) {
      headers['Content-Encoding'] = 'gzip';
      headers['Content-Length'] = file.gz.length;
      return send(200, headers, file.gz);
    }
    headers['Content-Length'] = file.body.length;
    send(200, headers, file.body);
  });

  const relay = attachRelay(server, relayOpts);
  return { server, relay };
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const { server, relay } = createServer();
  const port = Number(process.env.PORT) || 8080;
  server.listen(port, '0.0.0.0', () => console.log(`[eddy] listening on :${port}`));
  const stop = () => {
    relay.close();
    server.close(() => process.exit(0));
    server.closeAllConnections?.();
    setTimeout(() => process.exit(0), 3000).unref();
  };
  process.on('SIGTERM', stop);
  process.on('SIGINT', stop);
}
