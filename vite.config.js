import { defineConfig } from 'vite';
import { attachRelay } from './server/relay.js';

// Attach the shared-easel relay to Vite's own HTTP server so `npm run dev` is enough.
const relay = () => ({
  name: 'eddy-relay',
  configureServer(server) { if (server.httpServer) attachRelay(server.httpServer); },
  configurePreviewServer(server) { if (server.httpServer) attachRelay(server.httpServer); },
});

export default defineConfig({ plugins: [relay()] });
