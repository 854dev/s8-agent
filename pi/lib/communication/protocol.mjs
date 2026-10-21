// One Manager mediates every exchange. This protocol promises no offline delivery.
import { randomUUID } from 'node:crypto';

export const VERSION = 1;
export const MAX_BYTES = 64 * 1024;
export const MAX_PENDING = 100;
export const REQUEST_TIMEOUT_MS = 30_000;
export const RECEIPTS = ['accepted', 'pending', 'injected', 'claimed', 'finished', 'rejected', 'unavailable', 'timeout', 'unknown'];
const ID = /^[a-zA-Z0-9_-]{1,120}$/;
const WORKER = /^[a-z][a-z0-9-]{0,31}$/;
const matches = (pattern, value) => typeof value === 'string' && pattern.test(value);
const object = value => value !== null && typeof value === 'object' && !Array.isArray(value);
const agentTypes = ['agent.request', 'agent.reply', 'agent.notice', 'agent.proposal', 'agent.result'];
const managerTypes = new Set(['task.run', 'worker.mode.set', 'request.status', ...agentTypes]);
const workerTypes = new Set(['worker.status', 'worker.heartbeat', 'task.started', 'task.completed', 'task.failed', ...agentTypes, 'request.status']);
const commonTypes = ['request.accepted', 'request.rejected', 'request.result'];
for (const type of commonTypes) { managerTypes.add(type); workerTypes.add(type); }
const keys = new Set(['version', 'id', 'requestId', 'groupId', 'type', 'from', 'to', 'taskUid', 'runId', 'sessionId', 'replyTo', 'expiresAt', 'payload']);

/** Validate both shape and sender authorization, without including payloads in errors. */
export function validateMessage(value, identity, { now = Date.now() } = {}) {
  const fail = reason => { throw new Error(`Communication: ${reason}`); };
  if (!object(value) || Object.keys(value).some(key => !keys.has(key))) fail('invalid envelope');
  if (Buffer.byteLength(JSON.stringify(value)) > MAX_BYTES) fail('message too large');
  if (value.version !== VERSION) fail('unsupported protocol version');
  if (!matches(ID, value.id) || !matches(ID, value.requestId)) fail('invalid request identity');
  if (value.from !== identity || !matches(WORKER, identity)) fail('sender identity mismatch');
  const manager = identity === 'manager';
  if (manager ? !matches(WORKER, value.to) || value.to === 'manager' : value.to !== 'manager') fail('peer routing is forbidden');
  if (!(manager ? managerTypes : workerTypes).has(value.type)) fail('message type not permitted');
  for (const key of ['groupId', 'taskUid', 'runId', 'sessionId', 'replyTo']) {
    if (value[key] != null && (typeof value[key] !== 'string' || !ID.test(value[key]))) fail(`invalid ${key}`);
  }
  if (typeof value.expiresAt !== 'string' || !Number.isFinite(Date.parse(value.expiresAt)) || Date.parse(value.expiresAt) <= now || Date.parse(value.expiresAt) > now + 300_000) fail('message expired or outside the five-minute TTL limit');
  if (!object(value.payload)) fail('invalid payload');
  if (value.type === 'task.run' && (!matches(ID, value.payload.uid) || value.payload.uid !== value.taskUid)) fail('task UID required');
  if (value.type === 'worker.mode.set' && !['active', 'passive', 'paused', 'default'].includes(value.payload.mode)) fail('invalid Worker mode');
  if (agentTypes.includes(value.type) && (typeof value.payload.text !== 'string' || !value.payload.text.trim() || value.payload.text.length > 16_000)) fail('agent text required (maximum 16000 characters)');
  if (value.type === 'agent.request' && value.payload.deadlineAt != null && (typeof value.payload.deadlineAt !== 'string' || !Number.isFinite(Date.parse(value.payload.deadlineAt)) || Date.parse(value.payload.deadlineAt) > now + 3_600_000)) fail('invalid response deadline');
  if (value.type === 'agent.reply' && !value.replyTo) fail('reply correlation required');
  if (value.type.startsWith('request.') && value.type !== 'request.status' && !RECEIPTS.includes(value.payload.state)) fail('receipt state required');
  return value;
}

export function message(type, from, to, payload, context = {}) {
  const value = { version: VERSION, id: randomUUID(), requestId: randomUUID(), type, from, to, expiresAt: new Date(Date.now() + REQUEST_TIMEOUT_MS).toISOString(), payload, ...context };
  return validateMessage(value, from);
}

/** A live-process ledger, deliberately neither persistent nor an execution guarantee. */
export function requestLedger({ limit = MAX_PENDING, now = Date.now } = {}) {
  const entries = new Map();
  const prune = () => { for (const [id, item] of entries) if (item.expiresAt <= now()) entries.delete(id); };
  return {
    get(id) { prune(); return entries.get(id)?.value; },
    set(id, value, expiresAt) {
      prune();
      if (!Number.isFinite(expiresAt) || expiresAt <= now()) throw new Error('Communication: expired request');
      if (!entries.has(id) && entries.size >= limit) throw new Error('Communication: pending request limit reached');
      entries.set(id, { value, expiresAt });
    },
    // Disconnected requests are uncertain; they must never be silently replayed.
    disconnect() { for (const item of entries.values()) if (['accepted', 'pending'].includes(item.value.state)) item.value = { ...item.value, state: 'unknown' }; },
  };
}
