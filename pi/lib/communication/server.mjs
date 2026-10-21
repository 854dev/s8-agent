import http from 'node:http';
import { WebSocketServer } from 'ws';
import { MAX_BYTES, VERSION } from './protocol.mjs';
import { readCredentials, tokenMatches } from './credentials.mjs';
import { connectPeer } from './peer.mjs';
import { blobHandler } from './blobs.mjs';

export async function startCommunicationServer(config, { onMessage = async () => ({ state: 'unavailable', reason: 'Manager Pi is not connected' }), timeoutMs, artifactDirectory, onEvent } = {}) {
  const credentials = await readCredentials(config.credentialsFile);
  const workers = new Map();
  const authorize = req => {
    const id = req.headers['x-s8-worker'];
    return typeof id === 'string' && Object.hasOwn(credentials, id) && tokenMatches(req.headers.authorization, `Bearer ${credentials[id]}`);
  };
  const handleBlob = artifactDirectory && blobHandler(artifactDirectory, authorize);
  const server = http.createServer((req, res) => {
    if (handleBlob) void handleBlob(req, res);
    else { res.writeHead(404); res.end(); }
  });
  const sockets = new WebSocketServer({ noServer: true, maxPayload: MAX_BYTES, perMessageDeflate: false });
  server.on('upgrade', (req, socket, head) => {
    const id = req.headers['x-s8-worker'], nodeId = req.headers['x-s8-node'];
    const valid = req.url === '/' && !req.headers.origin && req.headers['x-s8-version'] === String(VERSION)
      && typeof id === 'string' && id !== 'manager' && typeof nodeId === 'string' && /^[a-z][a-z0-9-]{0,31}$/.test(nodeId)
      && authorize(req);
    if (!valid || workers.get(id)?.connected) {
      socket.end(`HTTP/1.1 ${valid ? '409 Conflict' : '401 Unauthorized'}\r\nConnection: close\r\n\r\n`);
      return;
    }
    sockets.handleUpgrade(req, socket, head, ws => {
      ws.s8Alive = true;
      const state = { id, nodeId, connected: true, connectedAt: new Date().toISOString(), lastSeen: Date.now(), status: null, peer: null };
      workers.set(id, state);
      state.peer = connectPeer(ws, 'manager', id, async input => {
        state.lastSeen = Date.now();
        if (input.type === 'worker.heartbeat' || input.type === 'worker.status') {
          state.status = input.payload;
          return { state: 'accepted' };
        }
        return onMessage(input);
      }, { timeoutMs, onEvent: event => onEvent?.({ ...event, nodeId: config.nodeId, remoteNodeId: nodeId }) });
      ws.on('pong', () => { state.lastSeen = Date.now(); ws.s8Alive = true; });
      ws.on('close', () => { if (workers.get(id) === state) { state.metrics = state.peer.metrics; state.connected = false; state.peer = null; } });
    });
  });
  const heartbeat = setInterval(() => {
    for (const ws of sockets.clients) {
      // Ping responses are also handled by WebSocket itself on the client.
      if (ws.s8Alive === false) ws.terminate();
      else { ws.s8Alive = false; ws.ping(); }
    }
  }, 15_000);
  heartbeat.unref();
  try {
    await new Promise((resolve, reject) => { server.once('error', reject); server.listen(config.server.port, config.server.bindIp, resolve); });
  } catch (error) { clearInterval(heartbeat); sockets.close(); throw error; }
  return {
    address: server.address(),
    workers: () => [...workers.values()].map(({ peer, lastSeen, ...state }) => ({
      mode: 'passive', configMode: 'passive', overridden: false, current: null, queue: [], lastError: null,
      ...state.status, ...state, metrics: peer?.metrics ?? state.metrics ?? null, running: state.connected, heartbeatAt: new Date(lastSeen).toISOString(),
    })),
    request: (id, type, payload, context) => workers.get(id)?.peer?.request(type, payload, context) ?? Promise.resolve({ state: 'unavailable', reason: 'Worker is not connected' }),
    async close() {
      clearInterval(heartbeat);
      for (const ws of sockets.clients) ws.terminate();
      await new Promise(resolve => sockets.close(resolve));
      await new Promise(resolve => server.close(resolve));
    },
  };
}
