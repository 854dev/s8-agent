import { message, validateMessage, MAX_BYTES, MAX_PENDING, REQUEST_TIMEOUT_MS } from './protocol.mjs';

/** Request/receipt exchange over one authenticated socket. No replay across connections. */
export function connectPeer(socket, identity, remote, handle, { timeoutMs = REQUEST_TIMEOUT_MS, onEvent = () => {} } = {}) {
  const pending = new Map(), recent = new Map();
  const metrics = { sent: 0, received: 0, failures: 0, lastError: null, lastLatencyMs: null };
  const observe = (direction, input, state, latencyMs) => {
    if (['rejected', 'unknown', 'unavailable', 'invalid'].includes(state)) { metrics.failures++; metrics.lastError = state; }
    if (latencyMs != null) metrics.lastLatencyMs = latencyMs;
    if (input && ['worker.status', 'worker.heartbeat'].includes(input.type)) return;
    try { onEvent({ at: new Date().toISOString(), direction, local: identity, peer: remote, from: input?.from, to: input?.to, type: input?.type, id: input?.id, requestId: input?.requestId, taskUid: input?.taskUid, runId: input?.runId, state, latencyMs }); } catch { /* Observability cannot break delivery. */ }
  };
  let inflight = 0, rate = 0, windowAt = Date.now();
  const send = value => { if (socket.readyState !== 1) throw new Error('Communication: unavailable'); socket.send(JSON.stringify(value)); };
  socket.on('message', async data => {
    let input;
    try {
      if (Date.now() - windowAt >= 60_000) { rate = 0; windowAt = Date.now(); }
      if (++rate > 600 || data.length > MAX_BYTES) throw new Error();
      input = validateMessage(JSON.parse(data.toString()), remote);
      if (input.to !== identity) throw new Error();
    } catch { observe('receive', null, 'invalid'); socket.close(1008, 'Invalid or unauthorized message'); return; }
    if (input.type === 'request.result' && input.replyTo) {
      const request = pending.get(input.replyTo);
      if (!request || request.requestId !== input.requestId) return;
      clearTimeout(request.timer);
      pending.delete(input.replyTo);
      observe('receipt', request.input, input.payload.state, Date.now() - request.startedAt);
      request.resolve(input.payload);
      return;
    }
    // Transport receipts cannot trigger another receipt or a model turn.
    if (input.type.startsWith('request.') && input.type !== 'request.status') { socket.close(1008, 'Unexpected receipt'); return; }
    for (const [id, entry] of recent) if (entry.until <= Date.now()) recent.delete(id);
    let entry = recent.get(input.id);
    if (entry && entry.serialized !== JSON.stringify(input)) { socket.close(1008, 'Request ID reused'); return; }
    if (!entry) {
      metrics.received++;
      observe('receive', input, 'accepted');
      const busy = inflight >= MAX_PENDING || recent.size >= 500;
      inflight++;
      entry = { until: Date.now() + 300_000, serialized: JSON.stringify(input), result: Promise.resolve().then(() => busy ? { state: 'rejected', reason: 'Request limit reached' } : handle(input)).catch(() => ({ state: 'rejected', reason: 'Request failed; inspect recipient logs' })).finally(() => inflight--) };
      // Never evict active deduplication entries to accept more traffic.
      if (!busy) recent.set(input.id, entry);
    }
    const result = await entry.result;
    observe('handled', input, result?.state);
    try { send(message('request.result', identity, remote, result, { requestId: input.requestId, replyTo: input.id })); }
    catch { /* Sender sees unknown on disconnect/timeout. No replay. */ }
  });
  socket.on('close', () => {
    for (const request of pending.values()) { clearTimeout(request.timer); observe('receipt', request.input, 'unknown'); request.resolve({ state: 'unknown', reason: 'Connection closed; reconcile before retry' }); }
    pending.clear();
  });
  socket.on('error', () => {}); // Close/timeout resolves requests without leaking headers or credentials.
  return {
    get metrics() { return { ...metrics, pending: pending.size }; },
    async request(type, payload, context = {}) {
      if (socket.readyState !== 1) return { state: 'unavailable' };
      if (pending.size >= MAX_PENDING) return { state: 'rejected', reason: 'Pending request limit reached' };
      const input = message(type, identity, remote, payload, context);
      return new Promise(resolve => {
        const timer = setTimeout(() => { pending.delete(input.id); observe('receipt', input, 'unknown'); resolve({ state: 'unknown', reason: 'Response timed out; reconcile before retry' }); }, timeoutMs);
        pending.set(input.id, { resolve, timer, requestId: input.requestId, input, startedAt: Date.now() });
        try { send(input); metrics.sent++; observe('send', input, 'sent'); }
        catch { clearTimeout(timer); pending.delete(input.id); resolve({ state: 'unknown' }); }
      });
    },
    close() { socket.close(); },
  };
}
