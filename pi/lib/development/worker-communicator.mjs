import { createServer } from 'node:http';
import { createHash, randomUUID, timingSafeEqual } from 'node:crypto';
import { createReadStream } from 'node:fs';
import path from 'node:path';
import { mkdir, readFile, writeFile, rename, lstat } from 'node:fs/promises';
import { saveJson } from '../storage/json-file.mjs';
import { loadS8Config } from '../config/s8-config.mjs';
import { validWorkerId, usesRemoteWorkspace } from './worker-identity.mjs';
import { ensureWorkerTokens, readWorkerToken } from './worker-auth.mjs';
import { getWorkerState, readWorkerResult, readWorkerMessages, workerStateFile, workerMessagesDirectory, withWorkerLock as lockWorker } from './worker-store.mjs';
import { protocolVersion, maxBodyBytes, maxArtifactBytes, defaultPollMs, resultArtifacts } from './worker-protocol.mjs';

const servers = new Map();
async function bodyJson(request) {
  const chunks = [];
  let size = 0;
  for await (const chunk of request) {
    size += chunk.length;
    if (size > maxBodyBytes) throw Object.assign(new Error('Request body too large'), { statusCode: 413 });
    chunks.push(chunk);
  }
  try { return JSON.parse(Buffer.concat(chunks).toString('utf8')); }
  catch { throw Object.assign(new Error('Invalid JSON'), { statusCode: 400 }); }
}

function reply(response, status, value) {
  response.writeHead(status, { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store', 'x-content-type-options': 'nosniff' });
  response.end(JSON.stringify(value));
}

function bearer(request) {
  const value = request.headers.authorization ?? '';
  return value.startsWith('Bearer ') ? value.slice(7) : '';
}

function tokensMatch(expected, actual) {
  const a = Buffer.from(expected), b = Buffer.from(actual);
  return a.length === b.length && timingSafeEqual(a, b);
}

async function authenticate(root, entries, request, workerId) {
  if (!validWorkerId(workerId) || !entries[workerId]) return null;
  let expected;
  try { expected = await readWorkerToken(root, workerId); } catch { return null; }
  return tokensMatch(expected, bearer(request)) ? entries[workerId] : null;
}

function validStateTransition(current, incoming) {
  const sameRun = Boolean(incoming.runId && incoming.runId === current.runId && incoming.uid === current.uid);
  const assigned = Boolean(incoming.runId && incoming.runId === current.assignedRunId && incoming.uid === current.assignedUid);
  if (incoming.status === 'idle') return (['offline', 'idle'].includes(current.status) && !current.runId) || (current.status === 'reported' && incoming.lastRunId === current.runId);
  if (incoming.status === 'accepting') return assigned || (current.status === 'accepting' && sameRun);
  if (incoming.status === 'busy') return (current.status === 'accepting' && assigned) || (['busy', 'unknown'].includes(current.status) && sameRun);
  if (incoming.status === 'reported') return ['busy', 'reported', 'unknown'].includes(current.status) && sameRun;
  if (incoming.status === 'unknown') return (!incoming.runId && !current.runId) || sameRun || assigned;
  if (incoming.status === 'stopping') return (['offline', 'idle', 'stopping'].includes(current.status) && !current.runId) || (['reported', 'stopping'].includes(current.status) && incoming.lastRunId === current.runId);
  return false;
}

async function artifactRoute({ root, request, response, workerId, current, parts }) {
  const [, , , , runId, name] = parts;
  const connectionId = request.headers['x-s8-connection-id'];
  if (!/^[a-f0-9-]{36}$/.test(runId ?? '') || typeof connectionId !== 'string' || connectionId !== current?.connectionId || current.runId !== runId || !['busy', 'reported'].includes(current.status)) return reply(response, 409, { error: 'artifact_run_mismatch' });
  const directory = path.join(root, '.s8-runtime/runs', runId);
  if (request.method === 'GET' && name === 'input.patch') {
    const file = path.join(directory, name);
    let stat;
    try { stat = await lstat(file); } catch (error) { if (error.code === 'ENOENT') return reply(response, 404, { error: 'artifact_not_found' }); throw error; }
    if (!stat.isFile() || stat.nlink !== 1 || stat.size > maxArtifactBytes) return reply(response, 400, { error: 'artifact_invalid' });
    response.writeHead(200, { 'content-type': 'application/octet-stream', 'content-length': stat.size, 'cache-control': 'no-store', 'x-content-type-options': 'nosniff' });
    createReadStream(file).pipe(response);
    return;
  }
  if (request.method !== 'PUT' || !resultArtifacts.has(name)) return reply(response, 404, { error: 'not_found' });
  const chunks = [];
  let size = 0;
  const hash = createHash('sha256');
  for await (const chunk of request) {
    size += chunk.length;
    if (size > maxArtifactBytes) return reply(response, 413, { error: 'artifact_too_large' });
    chunks.push(chunk); hash.update(chunk);
  }
  const digest = hash.digest('hex');
  if (!/^[a-f0-9]{64}$/.test(request.headers['x-artifact-sha256'] ?? '') || digest !== request.headers['x-artifact-sha256']) return reply(response, 400, { error: 'artifact_hash_mismatch' });
  await mkdir(directory, { recursive: true, mode: 0o700 });
  const file = path.join(directory, name), bytes = Buffer.concat(chunks);
  try {
    const existing = await readFile(file);
    if (createHash('sha256').update(existing).digest('hex') !== digest) return reply(response, 409, { error: 'artifact_conflict' });
    return reply(response, 200, { stored: true, sha256: digest, size });
  } catch (error) { if (error.code !== 'ENOENT') throw error; }
  const temporary = `${file}.${randomUUID()}.tmp`;
  await writeFile(temporary, bytes, { flag: 'wx', mode: 0o600 });
  await rename(temporary, file);
  return reply(response, 200, { stored: true, sha256: digest, size });
}

export async function startWorkerCommunicator({ root, entries = loadS8Config(root).workerEntries, settings = loadS8Config(root).workerCommunicator } = {}) {
  const key = `${root}:${settings.bindAddress}:${settings.port}`;
  entries = { ...entries };
  if (servers.has(key)) {
    const current = servers.get(key);
    for (const workerId of Object.keys(current.entries)) delete current.entries[workerId];
    Object.assign(current.entries, entries);
    await ensureWorkerTokens(root, Object.keys(entries));
    return current;
  }
  await ensureWorkerTokens(root, Object.keys(entries));
  await mkdir(path.join(root, '.s8-runtime/workers'), { recursive: true, mode: 0o700 });
  const withWorkerLock = (workerId, operation) => lockWorker(root, workerId, operation);
  const httpServer = createServer(async (request, response) => {
    try {
      const url = new URL(request.url, `http://${request.headers.host ?? 'localhost'}`);
      if (request.method === 'GET' && url.pathname === '/health') return reply(response, 200, { protocolVersion });
      const parts = url.pathname.split('/').filter(Boolean);
      if (parts[0] !== 'v1' || parts[1] !== 'workers' || parts.length < 4) return reply(response, 404, { error: 'not_found' });
      const workerId = parts[2], action = parts[3];
      const entry = await authenticate(root, entries, request, workerId);
      if (!entry) return reply(response, 401, { error: 'unauthorized' });
      if (action === 'poll' && request.method === 'GET') {
        const connectionId = url.searchParams.get('connectionId');
        const deadline = Date.now() + defaultPollMs;
        while (Date.now() < deadline && !response.destroyed) {
          const next = await withWorkerLock(workerId, async () => {
            const latest = await getWorkerState(root, workerId);
            if (!connectionId || latest?.connectionId !== connectionId) return { stale: true };
            const messages = await readWorkerMessages(root, workerId);
            const pending = messages.find(({ value }) => !['processed', 'canceled'].includes(value.status) && value.receivedConnectionId !== connectionId);
            if (!pending) return null;
            const message = pending.value;
            message.deliveryConnectionId = connectionId;
            message.deliveryCount = (message.deliveryCount ?? 0) + 1;
            if (message.type === 'assign') {
              const assignment = message.payload;
              if (!assignment || !/^[a-f0-9-]{36}$/.test(assignment.runId ?? '') || !/^[a-zA-Z0-9_-]{1,120}$/.test(assignment.uid ?? '')) return { invalid: true };
              if (['offline', 'idle'].includes(latest.status) && !latest.runId) {
                await saveJson(workerStateFile(root, workerId), { ...latest, status: 'accepting', assignedRunId: assignment.runId, assignedUid: assignment.uid, lastSeenAt: new Date().toISOString() });
              }
            }
            await saveJson(pending.file, message);
            return { message };
          });
          if (next?.stale) return reply(response, 409, { error: 'stale_connection' });
          if (next?.invalid) return reply(response, 400, { error: 'invalid_assignment_message' });
          if (next) return reply(response, 200, next);
          await new Promise(resolve => setTimeout(resolve, 200));
        }
        if (!response.destroyed) { response.writeHead(204, { 'cache-control': 'no-store' }); response.end(); }
        return;
      }
      return await withWorkerLock(workerId, async () => {
        if (request.method === 'POST' && action === 'connect') {
          const input = await bodyJson(request);
          if (input.protocolVersion !== protocolVersion || input.agent !== entry.agent || input.workerId !== workerId) return reply(response, 400, { error: 'protocol_or_identity_mismatch' });
          const state = await getWorkerState(root, workerId) ?? { workerId, status: 'offline' };
          const connectionId = randomUUID();
          const connected = { ...state, workerId, agent: entry.agent, host: entry.host, launch: entry.launch, root: entry.root, connectionId, connectedAt: new Date().toISOString(), lastSeenAt: new Date().toISOString(), connected: true };
          await saveJson(workerStateFile(root, workerId), connected);
          return reply(response, 200, { protocolVersion, connectionId, heartbeatIntervalMs: 5000 });
        }
        if (parts[3] === 'artifacts' && parts.length === 6) {
          const current = await getWorkerState(root, workerId);
          return await artifactRoute({ root, request, response, workerId, current, parts });
        }
        const input = request.method === 'POST' ? await bodyJson(request) : null;
        const current = await getWorkerState(root, workerId);
        if (!current || !input?.connectionId || input.connectionId !== current.connectionId) return reply(response, 409, { error: 'stale_connection' });
        if (action === 'heartbeat' && request.method === 'POST') {
          await saveJson(workerStateFile(root, workerId), { ...current, connected: true, lastSeenAt: new Date().toISOString() });
          return reply(response, 200, { saved: true });
        }
        if (action === 'state' && request.method === 'POST') {
          const status = input.state?.status;
          if (!['idle', 'accepting', 'busy', 'reported', 'stopping', 'unknown'].includes(status)) return reply(response, 400, { error: 'invalid_state' });
          if (!validStateTransition(current, input.state)) return reply(response, 409, { error: 'invalid_state_transition' });
          if (status === 'reported' && usesRemoteWorkspace(entry)) {
            const directory = path.join(root, '.s8-runtime/runs', input.state.runId);
            let report;
            try { report = await readWorkerResult(directory); }
            catch { return reply(response, 409, { error: 'worker_result_missing' }); }
            if (report.status === 'completed') {
              for (const name of ['task.patch', 'changes.patch']) {
                try { const stat = await lstat(path.join(directory, name)); if (!stat.isFile() || stat.nlink !== 1) return reply(response, 409, { error: 'worker_artifact_missing' }); }
                catch { return reply(response, 409, { error: 'worker_artifact_missing' }); }
              }
            }
          }
          const keepsAssignment = ['accepting', 'busy', 'reported', 'unknown'].includes(status) && input.state.runId === current.assignedRunId;
          const saved = { ...current, status, runId: input.state.runId, uid: input.state.uid, lastRunId: input.state.lastRunId, pid: input.state.pid, ...(keepsAssignment ? { assignedRunId: current.assignedRunId, assignedUid: current.assignedUid } : { assignedRunId: undefined, assignedUid: undefined }), workerId, agent: entry.agent, host: entry.host, launch: entry.launch, root: entry.root, connectionId: current.connectionId, connected: true, lastSeenAt: new Date().toISOString() };
          await saveJson(workerStateFile(root, workerId), saved);
          return reply(response, 200, { saved: true });
        }
        if (action === 'ack' && request.method === 'POST') {
          const messageId = input.messageId;
          if (!/^[a-f0-9-]{36}$/.test(messageId ?? '') || !['received', 'processed'].includes(input.phase)) return reply(response, 400, { error: 'invalid_ack' });
          const file = path.join(workerMessagesDirectory(root, workerId), `${messageId}.json`);
          let message;
          try { message = JSON.parse(await readFile(file, 'utf8')); } catch (error) { if (error.code === 'ENOENT') return reply(response, 404, { error: 'message_not_found' }); throw error; }
          if (message.status === 'canceled') return reply(response, 409, { error: 'assignment_withdrawn' });
          if (message.workerId !== workerId || message.deliveryConnectionId !== current.connectionId) return reply(response, 409, { error: 'message_ownership_mismatch' });
          if (input.phase === 'received') {
            message.receivedAt ??= new Date().toISOString();
            message.receivedConnectionId = current.connectionId;
          } else {
            message.status = 'processed';
            message.processedAt = new Date().toISOString();
            message.receivedConnectionId = current.connectionId;
            message.response = input.response;
          }
          await saveJson(file, message);
          const fresh = await getWorkerState(root, workerId);
          if (fresh?.connectionId === current.connectionId) {
            const rejectedAssignment = message.type === 'assign' && input.phase === 'processed' && input.response?.error && fresh.status === 'accepting' && !fresh.runId && fresh.assignedRunId === message.payload.runId;
            await saveJson(workerStateFile(root, workerId), { ...fresh, ...(rejectedAssignment ? { status: 'idle', assignedRunId: undefined, assignedUid: undefined } : {}), lastSeenAt: new Date().toISOString() });
          }
          return reply(response, 200, { acknowledged: true });
        }
        return reply(response, 404, { error: 'not_found' });
      });
    } catch (error) {
      return reply(response, error.statusCode ?? 500, { error: error.statusCode ? error.message : 'request_failed' });
    }
  });
  await new Promise((resolve, reject) => {
    httpServer.once('error', reject);
    httpServer.listen(settings.port, settings.bindAddress, resolve);
  }).catch(error => { httpServer.close(); throw error; });
  const handle = { server: httpServer, address: settings, entries, close: () => new Promise(resolve => { servers.delete(key); httpServer.close(resolve); httpServer.closeAllConnections(); }) };
  servers.set(key, handle);
  return handle;
}
