// comm-center server. Authenticates agents, routes text between them and relays delivery receipts.
// No offline delivery: a message to a disconnected agent is `unavailable`, and nothing is replayed.
import http from 'node:http';
import { WebSocketServer } from 'ws';
import { findAgent, readRegistry } from './registry.mjs';
import { CLOSE, HEARTBEAT_MS, HELLO_TIMEOUT_MS, MAX_BYTES, MAX_PENDING, REQUEST_TIMEOUT_MS, VERSION, canRoute, parseFrame } from './protocol.mjs';

const RATE_PER_MINUTE = 600;
const RECORD_TTL_MS = 300_000;
const MAX_RECORDS = 5000;

export async function startCommCenter({ agentsFile, host = '127.0.0.1', port = 8090, timeoutMs = REQUEST_TIMEOUT_MS, helloTimeoutMs = HELLO_TIMEOUT_MS, heartbeatMs = HEARTBEAT_MS, onEvent = () => {} }) {
  const registry = await readRegistry(agentsFile);
  const managers = [...registry].filter(([, entry]) => entry.role === 'manager').map(([id]) => id);
  const sessions = new Map(); // agent ID → connected session
  const records = new Map(); // `${from}\n${messageId}` → delivery record
  const emit = event => { try { onEvent({ at: new Date().toISOString(), ...event }); } catch { /* Observability cannot break delivery. */ } };
  const reply = (session, value) => { if (session.ws.readyState === 1) session.ws.send(JSON.stringify(value)); };

  const settle = (record, state, reason) => {
    record.state = state;
    if (!record.resolve) return;
    clearTimeout(record.timer);
    record.resolve(reason ? { state, reason } : { state });
    record.resolve = null;
    emit({ event: 'receipt', from: record.from, to: record.to, type: record.type, id: record.id, state, latencyMs: Date.now() - record.sentAt });
  };

  const prune = () => {
    const now = Date.now();
    for (const [key, record] of records) if (!record.resolve && record.expiresAt <= now) records.delete(key);
  };

  function send(session, input) {
    if (!input.to && (session.role !== 'worker' || managers.length !== 1)) return Promise.resolve({ state: 'rejected', reason: 'Recipient required' });
    const frame = { ...input, to: input.to ?? managers[0] };
    const key = `${session.id}\n${frame.id}`;
    const fingerprint = JSON.stringify([frame.to, frame.type, frame.text, frame.replyTo ?? null, frame.groupId ?? null]);
    const existing = records.get(key);
    // A retried send returns the original receipt and is never delivered twice.
    if (existing) return existing.fingerprint === fingerprint ? existing.receipt : Promise.resolve({ state: 'rejected', reason: 'Message ID reused' });
    const recipient = registry.get(frame.to);
    if (!recipient) return Promise.resolve({ state: 'unavailable', reason: 'Unknown agent' });
    if (!canRoute(session.role, recipient.role)) return Promise.resolve({ state: 'rejected', reason: 'Routing not permitted' });
    const target = sessions.get(frame.to);
    if (!target) return Promise.resolve({ state: 'unavailable', reason: 'Agent is not connected' });
    if (session.inflight >= MAX_PENDING) return Promise.resolve({ state: 'rejected', reason: 'Pending message limit reached' });
    prune();
    if (records.size >= MAX_RECORDS) return Promise.resolve({ state: 'rejected', reason: 'Center is busy' });
    const record = { id: frame.id, from: session.id, to: frame.to, type: frame.type, fingerprint, state: 'sent', sentAt: Date.now(), expiresAt: Date.now() + RECORD_TTL_MS };
    record.receipt = new Promise(resolve => { record.resolve = resolve; });
    record.timer = setTimeout(() => settle(record, 'unknown', 'Recipient did not acknowledge; reconcile before retry'), timeoutMs);
    records.set(key, record);
    session.inflight++;
    record.receipt.finally(() => { session.inflight--; });
    const message = { id: frame.id, from: session.id, to: frame.to, type: frame.type, text: frame.text, sentAt: new Date(record.sentAt).toISOString() };
    if (frame.replyTo) message.replyTo = frame.replyTo;
    if (frame.groupId) message.groupId = frame.groupId;
    reply(target, { kind: 'message', message });
    emit({ event: 'send', from: session.id, to: frame.to, type: frame.type, id: frame.id });
    return record.receipt;
  }

  function ack(session, frame) {
    const record = records.get(`${frame.from}\n${frame.for}`);
    // Only the recipient may acknowledge; unknown or foreign acks are ignored.
    if (!record || record.to !== session.id) return;
    settle(record, frame.state, frame.reason);
  }

  const peers = () => [...registry].map(([id, { role }]) => {
    const session = sessions.get(id);
    return { id, role, connected: Boolean(session), connectedAt: session?.connectedAt ?? null, lastSeenAt: session ? new Date(session.lastSeen).toISOString() : null };
  });

  async function handle(session, frame) {
    if (frame.kind === 'ack') return ack(session, frame);
    if (frame.kind === 'send') return reply(session, { kind: 'result', for: frame.id, to: frame.to ?? (session.role === 'worker' && managers.length === 1 ? managers[0] : null), ...await send(session, frame) });
    if (frame.kind === 'status') {
      const record = records.get(`${session.id}\n${frame.messageId}`);
      return reply(session, { kind: 'result', for: frame.id, state: record?.state === 'sent' ? 'unknown' : record?.state ?? 'unknown' });
    }
    if (frame.kind === 'peers') {
      if (session.role !== 'manager') return reply(session, { kind: 'result', for: frame.id, state: 'rejected', reason: 'Only managers can list peers' });
      return reply(session, { kind: 'result', for: frame.id, state: 'accepted', peers: peers() });
    }
    session.ws.close(CLOSE.policy, 'Unexpected frame');
  }

  function accept(ws) {
    let session = null, rate = 0, windowAt = Date.now();
    const hello = setTimeout(() => ws.close(CLOSE.unauthorized, 'Authentication timeout'), helloTimeoutMs);
    ws.on('error', () => {}); // Close handling resolves pending receipts without leaking frames.
    ws.on('message', (data, binary) => {
      let frame;
      try {
        if (Date.now() - windowAt >= 60_000) { rate = 0; windowAt = Date.now(); }
        if (binary || ++rate > RATE_PER_MINUTE) throw new Error();
        frame = parseFrame(JSON.parse(data.toString()));
      } catch { ws.close(CLOSE.policy, 'Invalid frame or rate limit'); return; }
      if (!session) {
        clearTimeout(hello);
        if (frame.kind !== 'hello') return ws.close(CLOSE.unauthorized, 'Authentication required');
        if (frame.version !== VERSION) return ws.close(CLOSE.version, 'Unsupported protocol version');
        const agent = findAgent(registry, frame.token);
        if (!agent) return ws.close(CLOSE.unauthorized, 'Authentication failed');
        if (sessions.has(agent.id)) return ws.close(CLOSE.duplicate, 'Agent already connected');
        session = { ...agent, ws, alive: true, inflight: 0, connectedAt: new Date().toISOString(), lastSeen: Date.now() };
        sessions.set(agent.id, session);
        ws.on('pong', () => { session.alive = true; session.lastSeen = Date.now(); });
        reply(session, { kind: 'welcome', agentId: agent.id, role: agent.role });
        emit({ event: 'connect', agentId: agent.id, role: agent.role });
        return;
      }
      if (frame.kind === 'hello') return ws.close(CLOSE.policy, 'Already authenticated');
      session.lastSeen = Date.now();
      handle(session, frame).catch(() => ws.close(CLOSE.policy, 'Request failed'));
    });
    ws.on('close', () => {
      clearTimeout(hello);
      if (!session || sessions.get(session.id) !== session) return;
      sessions.delete(session.id);
      // Queued but not yet injected messages are lost with the session.
      for (const record of records.values()) if (record.to === session.id && ['sent', 'pending'].includes(record.state)) settle(record, 'unknown', 'Recipient disconnected; reconcile before retry');
      emit({ event: 'disconnect', agentId: session.id });
    });
  }

  const server = http.createServer((_req, res) => { res.writeHead(404); res.end(); });
  const sockets = new WebSocketServer({ noServer: true, maxPayload: MAX_BYTES, perMessageDeflate: false });
  server.on('upgrade', (req, socket, head) => {
    // Browsers always send Origin; agent clients do not.
    if (req.url !== '/' || req.headers.origin) { socket.end('HTTP/1.1 403 Forbidden\r\nConnection: close\r\n\r\n'); return; }
    sockets.handleUpgrade(req, socket, head, accept);
  });
  const heartbeat = setInterval(() => {
    for (const session of sessions.values()) {
      if (!session.alive) { session.ws.terminate(); continue; }
      session.alive = false;
      // Protocol pings detect dead clients; the `ping` frame lets clients without ping access detect a dead center.
      session.ws.ping();
      reply(session, { kind: 'ping' });
    }
  }, heartbeatMs);
  heartbeat.unref();
  try {
    await new Promise((resolve, reject) => { server.once('error', reject); server.listen(port, host, resolve); });
  } catch (error) { clearInterval(heartbeat); sockets.close(); throw error; }

  return {
    address: server.address(),
    peers,
    async close() {
      clearInterval(heartbeat);
      for (const ws of sockets.clients) ws.terminate();
      await new Promise(resolve => sockets.close(resolve));
      await new Promise(resolve => server.close(resolve));
    },
  };
}
