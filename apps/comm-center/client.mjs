// comm-center client. Uses only Node's built-in WebSocket so Pi can import it without installing this app.
// One reconnecting connection per agent session. Pending requests are never replayed after a disconnect.
import { randomUUID } from 'node:crypto';
import { ACK_STATES, CLOSE, HEARTBEAT_MS, REQUEST_TIMEOUT_MS, VERSION, parseFrame } from './protocol.mjs';

const CLOSE_ERRORS = { [CLOSE.version]: 'VERSION_MISMATCH', [CLOSE.unauthorized]: 'UNAUTHORIZED', [CLOSE.duplicate]: 'DUPLICATE_AGENT', [CLOSE.policy]: 'POLICY_VIOLATION' };
// Configuration errors do not fix themselves by retrying.
const FATAL = new Set([CLOSE.version, CLOSE.unauthorized]);

/**
 * onMessage(message) returns 'pending' | 'injected' | 'rejected' (or { state, reason }) and is sent back as the receipt.
 * Later state changes for the same message go through ack(message, state).
 */
export function connectCommCenter({ url, token, onMessage = () => ({ state: 'rejected', reason: 'No receiver' }), onState = () => {}, reconnectMs = 2000, timeoutMs = REQUEST_TIMEOUT_MS + 5000, idleMs = HEARTBEAT_MS * 3 }) {
  let socket, timer, idle, identity = null, lastError = null, stopped = false;
  const pending = new Map();
  const write = value => socket.send(JSON.stringify(value));

  const ack = (message, result) => {
    const { state, reason } = typeof result === 'string' ? { state: result } : result ?? {};
    if (!identity || socket.readyState !== WebSocket.OPEN) return false;
    const frame = { kind: 'ack', for: message.id, from: message.from, state: ACK_STATES.includes(state) ? state : 'rejected' };
    if (typeof reason === 'string' && reason) frame.reason = reason.slice(0, 200);
    write(frame);
    return true;
  };

  // Built-in WebSocket hides protocol pings, so a half-open connection is detected by silence.
  const watch = target => {
    clearTimeout(idle);
    idle = setTimeout(() => { if (socket === target) { target.timedOut = true; target.close(); } }, idleMs);
  };

  const connect = () => {
    if (stopped) return;
    const current = socket = new WebSocket(url);
    watch(current);
    socket.addEventListener('open', () => write({ kind: 'hello', version: VERSION, token }));
    socket.addEventListener('message', async event => {
      watch(current);
      let frame;
      try { frame = JSON.parse(String(event.data)); } catch { return; }
      if (frame?.kind === 'welcome') {
        identity = { agentId: frame.agentId, role: frame.role };
        lastError = null;
        onState(true);
      } else if (frame?.kind === 'result') {
        const request = pending.get(frame.for);
        if (!request) return;
        clearTimeout(request.timer);
        pending.delete(frame.for);
        const { kind: _kind, for: _for, ...result } = frame;
        request.resolve(result);
      } else if (frame?.kind === 'message') {
        let result;
        try { result = await onMessage(frame.message); } catch { result = { state: 'rejected', reason: 'Receiver failed' }; }
        ack(frame.message, result);
      }
    });
    socket.addEventListener('error', () => {});
    socket.addEventListener('close', event => {
      if (socket !== current) return;
      clearTimeout(idle);
      const wasConnected = Boolean(identity);
      identity = null;
      lastError = CLOSE_ERRORS[event.code] ?? (current.timedOut ? 'TIMEOUT' : wasConnected ? 'DISCONNECTED' : 'CONNECTION_FAILED');
      for (const request of pending.values()) { clearTimeout(request.timer); request.resolve({ state: 'unknown', reason: 'Connection closed; reconcile before retry' }); }
      pending.clear();
      onState(false, lastError);
      if (!stopped && !FATAL.has(event.code)) timer = setTimeout(connect, reconnectMs);
    });
  };

  const request = frame => {
    // The center closes the connection on an invalid frame, so reject it here instead.
    try { parseFrame(frame); } catch { return Promise.resolve({ state: 'rejected', reason: 'Invalid message' }); }
    if (!identity || socket.readyState !== WebSocket.OPEN) return Promise.resolve({ state: 'unavailable', reason: 'Not connected to comm-center' });
    return new Promise(resolve => {
      const timeout = setTimeout(() => { pending.delete(frame.id); resolve({ state: 'unknown', reason: 'Response timed out; reconcile before retry' }); }, timeoutMs);
      pending.set(frame.id, { resolve, timer: timeout });
      write(frame);
    });
  };

  connect();
  return {
    get connected() { return Boolean(identity); },
    get agentId() { return identity?.agentId ?? null; },
    get role() { return identity?.role ?? null; },
    get lastError() { return lastError; },
    /** Send text. Workers may omit `to` to reach the manager. Returns { id, to, state, reason? }; pass the same id to retry without redelivery. */
    async send({ to, type, text, replyTo, groupId, id = randomUUID() }) {
      const frame = { kind: 'send', id, to, type, text };
      if (replyTo) frame.replyTo = replyTo;
      if (groupId) frame.groupId = groupId;
      return { id, ...await request(frame) };
    },
    status: messageId => request({ kind: 'status', id: randomUUID(), messageId }),
    peers: () => request({ kind: 'peers', id: randomUUID() }),
    ack,
    async close() {
      stopped = true;
      clearTimeout(timer);
      clearTimeout(idle);
      if (socket.readyState === WebSocket.CLOSED) return;
      await new Promise(resolve => { socket.addEventListener('close', resolve, { once: true }); socket.close(); });
    },
  };
}
