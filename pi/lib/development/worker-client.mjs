import { createHash } from 'node:crypto';
import { loadS8Config } from '../config/s8-config.mjs';
import { readWorkerToken } from './worker-auth.mjs';
import { protocolVersion, defaultPollMs, maxArtifactBytes, resultArtifacts } from './worker-protocol.mjs';

async function httpJson(root, workerId, endpoint, { method = 'POST', body, timeoutMs = 10000, signal } = {}) {
  const settings = loadS8Config(root).workerCommunicator;
  const token = await readWorkerToken(root, workerId);
  const response = await fetch(`${settings.url}/v1/workers/${encodeURIComponent(workerId)}/${endpoint}`, {
    method, headers: { authorization: `Bearer ${token}`, ...(body === undefined ? {} : { 'content-type': 'application/json' }) },
    body: body === undefined ? undefined : JSON.stringify(body), signal: signal ? AbortSignal.any([signal, AbortSignal.timeout(timeoutMs)]) : AbortSignal.timeout(timeoutMs),
  });
  if (response.status === 204) return null;
  const result = await response.json().catch(() => ({}));
  if (!response.ok) throw Object.assign(new Error(`Worker communicator HTTP ${response.status}: ${result.error ?? 'request_failed'}`), { status: response.status, code: result.error });
  return result;
}

export async function connectWorker(root, workerId, agent) {
  return httpJson(root, workerId, 'connect', { body: { protocolVersion, workerId, agent } });
}

export async function postWorkerState(root, workerId, connectionId, state) {
  return httpJson(root, workerId, 'state', { body: { connectionId, state } });
}

export async function postWorkerHeartbeat(root, workerId, connectionId) {
  return httpJson(root, workerId, 'heartbeat', { body: { connectionId } });
}

export async function pollWorkerMessage(root, workerId, connectionId, signal) {
  return httpJson(root, workerId, `poll?connectionId=${encodeURIComponent(connectionId)}`, { method: 'GET', timeoutMs: defaultPollMs + 5000, signal });
}

export async function acknowledgeWorkerMessage(root, workerId, connectionId, messageId, phase, response) {
  return httpJson(root, workerId, 'ack', { body: { connectionId, messageId, phase, response } });
}

export async function downloadWorkerArtifact(root, workerId, connectionId, runId, name) {
  if (!/^[a-f0-9-]{36}$/.test(runId) || name !== 'input.patch') throw new Error('Invalid worker artifact reference');
  const settings = loadS8Config(root).workerCommunicator, token = await readWorkerToken(root, workerId);
  const response = await fetch(`${settings.url}/v1/workers/${encodeURIComponent(workerId)}/artifacts/${runId}/${name}`, {
    headers: { authorization: `Bearer ${token}`, 'x-s8-connection-id': connectionId }, signal: AbortSignal.timeout(60_000),
  });
  if (!response.ok) throw new Error(`Worker artifact download HTTP ${response.status}`);
  const bytes = Buffer.from(await response.arrayBuffer());
  if (bytes.length > maxArtifactBytes) throw new Error('Worker input artifact is too large');
  return { bytes, sha256: createHash('sha256').update(bytes).digest('hex') };
}

export async function uploadWorkerArtifact(root, workerId, connectionId, runId, name, content, { signal } = {}) {
  if (!/^[a-f0-9-]{36}$/.test(runId) || !resultArtifacts.has(name)) throw new Error('Invalid worker artifact reference');
  const bytes = Buffer.isBuffer(content) ? content : Buffer.from(content);
  if (bytes.length > maxArtifactBytes) throw Object.assign(new Error('Worker output artifact is too large'), { permanent: true });
  const settings = loadS8Config(root).workerCommunicator, token = await readWorkerToken(root, workerId);
  const response = await fetch(`${settings.url}/v1/workers/${encodeURIComponent(workerId)}/artifacts/${runId}/${name}`, {
    method: 'PUT', headers: { authorization: `Bearer ${token}`, 'x-s8-connection-id': connectionId, 'content-type': 'application/octet-stream', 'x-artifact-sha256': createHash('sha256').update(bytes).digest('hex') },
    body: bytes, signal: signal ? AbortSignal.any([signal, AbortSignal.timeout(60_000)]) : AbortSignal.timeout(60_000),
  });
  const result = await response.json().catch(() => ({}));
  if (!response.ok) throw Object.assign(new Error(`Worker artifact upload HTTP ${response.status}: ${result.error ?? 'request_failed'}`), { status: response.status, code: result.error, permanent: [400, 413].includes(response.status) || result.error === 'artifact_conflict' });
  return result;
}

