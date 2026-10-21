import { WebSocket } from 'ws';
import { readCredentials } from './credentials.mjs';
import { connectPeer } from './peer.mjs';
import { MAX_BYTES, VERSION } from './protocol.mjs';

/** One resident Worker owns this reconnecting connection. Pending requests are never replayed. */
export async function startWorkerConnection(config, workerId, { onMessage, onConnection = () => {}, reconnectMs = 2000, timeoutMs } = {}) {
  const credentials = await readCredentials(config.credentialsFile);
  if (!Object.hasOwn(credentials, workerId)) throw new Error('Communication: this Worker has no configured credential');
  let socket, peer, timer, stopped = false, lastError;
  const connect = () => {
    if (stopped) return;
    socket = new WebSocket(config.managerUrl, {
      headers: { authorization: `Bearer ${credentials[workerId]}`, 'x-s8-worker': workerId, 'x-s8-node': config.nodeId, 'x-s8-version': String(VERSION) },
      maxPayload: MAX_BYTES, perMessageDeflate: false, handshakeTimeout: 5000,
    });
    socket.on('open', () => {
      lastError = null;
      peer = connectPeer(socket, workerId, 'manager', onMessage, { timeoutMs });
      onConnection(true);
    });
    socket.on('unexpected-response', (_request, response) => {
      lastError = `HTTP_${response.statusCode}`;
      response.destroy(); socket.terminate();
    });
    socket.on('error', error => { lastError ??= ['ECONNREFUSED', 'ETIMEDOUT', 'ENOTFOUND'].includes(error.code) ? error.code : 'CONNECTION_FAILED'; });
    socket.on('close', () => {
      peer = null;
      onConnection(false, lastError ?? 'DISCONNECTED');
      if (!stopped) timer = setTimeout(connect, reconnectMs);
    });
  };
  connect();
  return {
    get connected() { return socket?.readyState === 1; },
    get lastError() { return lastError; },
    request: (type, payload, context) => peer?.request(type, payload, context) ?? Promise.resolve({ state: 'unavailable' }),
    async close() {
      stopped = true; clearTimeout(timer);
      if (socket.readyState === 3) return;
      await new Promise(resolve => { socket.once('close', resolve); socket.terminate(); });
    },
  };
}
