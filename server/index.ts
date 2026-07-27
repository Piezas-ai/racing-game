/** Piezas Kart game server: auth API + WebSocket race relay.
 * Durable data (players, race results) lives in Piezas; this process holds
 * only ephemeral room state. */
import http from 'node:http';
import path from 'node:path';
import { existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import express from 'express';
import { WebSocketServer } from 'ws';
import { authRouter } from './auth';
import { setupPiezas } from './piezas';
import { sessionFromCookieHeader } from './session';
import { createClient, handleClose, handleMessage } from './rooms';

const envPath = fileURLToPath(new URL('../.env', import.meta.url));
if (existsSync(envPath)) {
  try {
    process.loadEnvFile(envPath);
  } catch {
    // Already-set environment variables win; a malformed .env shouldn't crash.
  }
}

const PORT = Number(process.env.PORT || 8787);
const app = express();
app.use(express.json());
app.use(authRouter);

// Serve the built client when it exists: ./public next to the deployed bundle,
// or client/dist when running from source (npm start after npm run build).
const staticCandidates = ['./public', '../client/dist'].map((p) =>
  fileURLToPath(new URL(p, import.meta.url)),
);
const staticDir = staticCandidates.find((p) => existsSync(path.join(p, 'index.html')));
if (staticDir) {
  app.use(express.static(staticDir));
  // SPA fallback so /game/12345 deep links load the app.
  app.get(/^\/(?!api\/|ws).*/, (_req, res) => res.sendFile(path.join(staticDir, 'index.html')));
}

const server = http.createServer(app);
const wss = new WebSocketServer({ noServer: true });

server.on('upgrade', async (req, socket, head) => {
  if (!req.url || !req.url.startsWith('/ws')) {
    socket.destroy();
    return;
  }
  socket.on('error', () => undefined);
  const session = await sessionFromCookieHeader(req.headers.cookie);
  if (!session || socket.destroyed) {
    socket.write('HTTP/1.1 401 Unauthorized\r\n\r\n');
    socket.destroy();
    return;
  }
  wss.handleUpgrade(req, socket, head, (ws) => {
    const client = createClient(ws, session.user);
    ws.on('message', (data) => handleMessage(client, data.toString()));
    ws.on('close', () => handleClose(client));
  });
});

async function main() {
  await setupPiezas();
  server.listen(PORT, () => {
    console.log(`Vancouver Road Simulator server on http://localhost:${PORT}`);
  });
}

main().catch((err) => {
  console.error('Server failed to start:', err);
  process.exit(1);
});
