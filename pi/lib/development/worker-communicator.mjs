import { createServer } from 'node:http';
import { createHash, randomBytes, randomUUID, timingSafeEqual } from 'node:crypto';
import { constants, closeSync, fstatSync, openSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { createReadStream } from 'node:fs';
import { mkdir, readFile, readdir, writeFile, chmod, rename, lstat } from 'node:fs/promises';
import { saveJson } from '../storage/json-file.mjs';
import { loadS8Config } from '../config/s8-config.mjs';
import { validWorkerId } from './worker-identity.mjs';

const protocolVersion = 1;
const maxBodyBytes = 16 * 1024 * 1024;
const maxArtifactBytes = 64 * 1024 * 1024;
const defaultPollMs = 20_000;
const resultArtifacts = new Set(['worker-result.json', 'task.patch', 'changes.patch', 'developer.events.jsonl']);
const servers = new Map();
export const workerStateFile = (root, workerId) => path.join(root, '.s8-runtime/workers', `${workerId}.json`);
export const workerMessagesDirectory = (root, workerId) => path.join(root, '.s8-runtime/workers/messages', workerId);
const tokenFile = (root, workerId) => path.join(root, '.s8-runtime/worker-auth', `${workerId}.token`);

async function ensureAuthDirectory(root) {
  const directory = path.join(root, '.s8-runtime/worker-auth');
  await mkdir(directory, { recursive: true, mode: 0o700 });
  const stat = await lstat(directory);
  if (!stat.isDirectory() || stat.isSymbolicLink()) throw new Error('Worker authentication directory must be a real directory');
  await chmod(directory, 0o700);
  return directory;
}

export async function ensureWorkerTokens(root, workerIds) {
  await ensureAuthDirectory(root);
  for (const workerId of workerIds) {
    if (!validWorkerId(workerId)) throw new Error('Invalid worker ID');
    const file = tokenFile(root, workerId);
    try { await writeFile(file, `${randomBytes(32).toString('base64url')}\n`, { flag: 'wx', mode: 0o600 }); }
    catch (error) { if (error.code !== 'EEXIST') throw error; }
    await readWorkerToken(root, workerId);
  }
}

export async function readWorkerToken(root, workerId) {
  if (!validWorkerId(workerId)) throw new Error('Invalid worker ID');
  const file = tokenFile(root, workerId);
  let fd;
  try { fd = openSync(file, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0) | (constants.O_NONBLOCK ?? 0)); }
  catch { throw new Error(`Worker authentication is not provisioned for ${workerId}`); }
  let token;
  try {
    const stat = fstatSync(fd);
    if (!stat.isFile() || stat.nlink !== 1 || stat.size > 128 || (stat.mode & 0o077) !== 0) throw new Error(`Worker authentication file permissions are invalid for ${workerId}`);
    token = readFileSync(fd, 'utf8').trim();
  } finally { closeSync(fd); }
  if (!/^[A-Za-z0-9_-]{40,60}$/.test(token)) throw new Error(`Worker authentication is not provisioned for ${workerId}`);
  return token;
}

export async function workerTokenForProvisioning(root, workerId) {
  await ensureWorkerTokens(root, [workerId]);
  return tokenFile(root, workerId);
}

export async function rotateWorkerToken(root, workerId) {
  if (!validWorkerId(workerId)) throw new Error('Invalid worker ID');
  await ensureAuthDirectory(root);
  const file = tokenFile(root, workerId), temporary = `${file}.${randomUUID()}.tmp`;
  await writeFile(temporary, `${randomBytes(32).toString('base64url')}\n`, { flag: 'wx', mode: 0o600 });
  await rename(temporary, file);
  return file;
}

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

async function readState(root, workerId) {
  try { return JSON.parse(await readFile(workerStateFile(root, workerId), 'utf8')); }
  catch (error) { if (error.code === 'ENOENT') return null; throw error; }
}

function validStateTransition(current, incoming) {
  const sameRun = Boolean(incoming.runId && incoming.runId === current.runId && incoming.uid === current.uid);
  const assigned = Boolean(incoming.runId && incoming.runId === current.assignedRunId && incoming.uid === current.assignedUid);
  if (incoming.status === 'idle') return (['offline', 'idle'].includes(current.status) && !current.runId) || (current.status === 'reported' && incoming.lastRunId === current.runId);
  if (incoming.status === 'accepting') return assigned || (current.status === 'accepting' && sameRun);
  if (incoming.status === 'busy') return assigned || (['accepting', 'busy', 'unknown'].includes(current.status) && sameRun);
  if (incoming.status === 'reported') return ['busy', 'reported'].includes(current.status) && sameRun;
  if (incoming.status === 'unknown') return (!incoming.runId && !current.runId) || sameRun || incoming.runId === current.runId;
  if (incoming.status === 'stopping') return (['offline', 'idle', 'stopping'].includes(current.status) && !current.runId) || (['reported', 'stopping'].includes(current.status) && incoming.lastRunId === current.runId);
  return false;
}

async function readMessages(root, workerId) {
  const directory = workerMessagesDirectory(root, workerId);
  let names;
  try { names = (await readdir(directory)).filter(name => /^[a-f0-9-]{36}\.json$/.test(name)).sort(); }
  catch (error) { if (error.code === 'ENOENT') return []; throw error; }
  const result = [];
  for (const name of names) {
    try { result.push({ file: path.join(directory, name), value: JSON.parse(await readFile(path.join(directory, name), 'utf8')) }); }
    catch (error) { if (error.code !== 'ENOENT') throw error; }
  }
  return result;
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

export async function enqueueWorkerMessage(root, workerId, type, payload) {
  if (!validWorkerId(workerId) || !['assign', 'cancel', 'release', 'drain', 'ping'].includes(type)) throw new Error('Invalid worker message');
  const messageId = randomUUID();
  const message = { protocolVersion, messageId, workerId, type, payload, status: 'queued', createdAt: new Date().toISOString() };
  const directory = workerMessagesDirectory(root, workerId);
  await mkdir(directory, { recursive: true, mode: 0o700 });
  const file = path.join(directory, `${messageId}.json`);
  await saveJson(file, message);
  return { messageId, file };
}

export async function getWorkerState(root, workerId) {
  return readState(root, workerId);
}

export async function waitForWorkerMessage(root, workerId, messageId, timeoutMs = 5000) {
  const file = path.join(workerMessagesDirectory(root, workerId), `${messageId}.json`);
  const until = Date.now() + timeoutMs;
  while (Date.now() < until) {
    try {
      const value = JSON.parse(await readFile(file, 'utf8'));
      if (value.status === 'processed') return value.response ?? { accepted: true };
    } catch (error) { if (error.code !== 'ENOENT') throw error; }
    await new Promise(resolve => setTimeout(resolve, 25));
  }
  throw new Error('Worker command acknowledgement timed out');
}

export async function startWorkerCommunicator({ root, entries = loadS8Config(root).workerEntries, settings = loadS8Config(root).workerCommunicator } = {}) {
  const key = `${root}:${settings.bindAddress}:${settings.port}`;
  if (servers.has(key)) {
    const current = servers.get(key);
    Object.assign(current.entries, entries);
    await ensureWorkerTokens(root, Object.keys(entries));
    return current;
  }
  await ensureWorkerTokens(root, Object.keys(entries));
  await mkdir(path.join(root, '.s8-runtime/workers'), { recursive: true, mode: 0o700 });
  const httpServer = createServer(async (request, response) => {
    const url = new URL(request.url, `http://${request.headers.host ?? 'localhost'}`);
    if (request.method === 'GET' && url.pathname === '/health') return reply(response, 200, { protocolVersion });
    const parts = url.pathname.split('/').filter(Boolean);
    if (parts[0] !== 'v1' || parts[1] !== 'workers' || parts.length < 4) return reply(response, 404, { error: 'not_found' });
    const workerId = parts[2], action = parts[3];
    const entry = await authenticate(root, entries, request, workerId);
    if (!entry) return reply(response, 401, { error: 'unauthorized' });
    try {
      if (request.method === 'POST' && action === 'connect') {
        const input = await bodyJson(request);
        if (input.protocolVersion !== protocolVersion || input.agent !== entry.agent || input.workerId !== workerId) return reply(response, 400, { error: 'protocol_or_identity_mismatch' });
        const state = await readState(root, workerId) ?? { workerId, status: 'offline' };
        const connectionId = randomUUID();
        const connected = { ...state, workerId, agent: entry.agent, host: entry.host, launch: entry.launch, root: entry.root, connectionId, connectedAt: new Date().toISOString(), lastSeenAt: new Date().toISOString(), connected: true };
        await saveJson(workerStateFile(root, workerId), connected);
        return reply(response, 200, { protocolVersion, connectionId, heartbeatIntervalMs: 5000 });
      }
      if (parts[3] === 'artifacts' && parts.length === 6) {
        const current = await readState(root, workerId);
        return await artifactRoute({ root, request, response, workerId, current, parts });
      }
      const input = request.method === 'POST' && action !== 'poll' ? await bodyJson(request) : null;
      const current = await readState(root, workerId);
      if (!current || !input?.connectionId && action !== 'poll' || (input?.connectionId ?? url.searchParams.get('connectionId')) !== current.connectionId) return reply(response, 409, { error: 'stale_connection' });
      if (action === 'state' && request.method === 'POST') {
        const status = input.state?.status;
        if (!['idle', 'accepting', 'busy', 'reported', 'stopping', 'unknown'].includes(status)) return reply(response, 400, { error: 'invalid_state' });
        if (!validStateTransition(current, input.state)) return reply(response, 409, { error: 'invalid_state_transition' });
        if (status === 'reported' && entry.host?.startsWith('ssh://')) {
          const directory = path.join(root, '.s8-runtime/runs', input.state.runId);
          let report;
          try { report = JSON.parse(await readFile(path.join(directory, 'worker-result.json'), 'utf8')); }
          catch { return reply(response, 409, { error: 'worker_result_missing' }); }
          if (report.status === 'completed') {
            for (const name of ['task.patch', 'changes.patch']) {
              try { const stat = await lstat(path.join(directory, name)); if (!stat.isFile() || stat.nlink !== 1) return reply(response, 409, { error: 'worker_artifact_missing' }); }
              catch { return reply(response, 409, { error: 'worker_artifact_missing' }); }
            }
          }
        }
        const keepsAssignment = ['accepting', 'busy', 'reported', 'unknown'].includes(status) && input.state.runId === current.assignedRunId;
        const saved = { ...current, ...input.state, ...(keepsAssignment ? { assignedRunId: current.assignedRunId, assignedUid: current.assignedUid } : { assignedRunId: undefined, assignedUid: undefined }), workerId, agent: entry.agent, host: entry.host, launch: entry.launch, root: entry.root, connectionId: current.connectionId, connected: true, lastSeenAt: new Date().toISOString() };
        await saveJson(workerStateFile(root, workerId), saved);
        return reply(response, 200, { saved: true });
      }
      if (action === 'poll' && request.method === 'GET') {
        const connectionId = url.searchParams.get('connectionId');
        if (!connectionId || connectionId !== current.connectionId) return reply(response, 409, { error: 'stale_connection' });
        const deadline = Date.now() + defaultPollMs;
        while (Date.now() < deadline && !response.destroyed) {
          const latest = await readState(root, workerId);
          if (latest?.connectionId !== connectionId) return reply(response, 409, { error: 'stale_connection' });
          const messages = await readMessages(root, workerId);
          const next = messages.find(({ value }) => value.status !== 'processed' && value.receivedConnectionId !== connectionId);
          if (next) {
            next.value.deliveryConnectionId = connectionId;
            next.value.deliveryCount = (next.value.deliveryCount ?? 0) + 1;
            if (next.value.type === 'assign') {
              const assignment = next.value.payload;
              if (!assignment || !/^[a-f0-9-]{36}$/.test(assignment.runId ?? '') || typeof assignment.uid !== 'string' || assignment.uid.length > 120) return reply(response, 400, { error: 'invalid_assignment_message' });
              await saveJson(workerStateFile(root, workerId), { ...latest, status: 'accepting', assignedRunId: assignment.runId, assignedUid: assignment.uid, lastSeenAt: new Date().toISOString() });
            }
            await saveJson(next.file, next.value);
            return reply(response, 200, { message: next.value });
          }
          await new Promise(resolve => setTimeout(resolve, 200));
        }
        if (!response.destroyed) { response.writeHead(204, { 'cache-control': 'no-store' }); response.end(); }
        return;
      }
      if (action === 'ack' && request.method === 'POST') {
        const messageId = input.messageId;
        if (!/^[a-f0-9-]{36}$/.test(messageId ?? '') || !['received', 'processed'].includes(input.phase)) return reply(response, 400, { error: 'invalid_ack' });
        const file = path.join(workerMessagesDirectory(root, workerId), `${messageId}.json`);
        let message;
        try { message = JSON.parse(await readFile(file, 'utf8')); } catch (error) { if (error.code === 'ENOENT') return reply(response, 404, { error: 'message_not_found' }); throw error; }
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
        const fresh = await readState(root, workerId);
        if (fresh?.connectionId === current.connectionId) await saveJson(workerStateFile(root, workerId), { ...fresh, lastSeenAt: new Date().toISOString() });
        return reply(response, 200, { acknowledged: true });
      }
      return reply(response, 404, { error: 'not_found' });
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

async function httpJson(root, workerId, endpoint, { method = 'POST', body, timeoutMs = 10000, signal } = {}) {
  const settings = loadS8Config(root).workerCommunicator;
  const token = await readWorkerToken(root, workerId);
  const response = await fetch(`${settings.url}/v1/workers/${encodeURIComponent(workerId)}/${endpoint}`, {
    method, headers: { authorization: `Bearer ${token}`, ...(body === undefined ? {} : { 'content-type': 'application/json' }) },
    body: body === undefined ? undefined : JSON.stringify(body), signal: signal ? AbortSignal.any([signal, AbortSignal.timeout(timeoutMs)]) : AbortSignal.timeout(timeoutMs),
  });
  if (response.status === 204) return null;
  const result = await response.json().catch(() => ({}));
  if (!response.ok) throw new Error(`Worker communicator HTTP ${response.status}: ${result.error ?? 'request_failed'}`);
  return result;
}

export async function connectWorker(root, workerId, agent) {
  return httpJson(root, workerId, 'connect', { body: { protocolVersion, workerId, agent } });
}

export async function postWorkerState(root, workerId, connectionId, state) {
  return httpJson(root, workerId, 'state', { body: { connectionId, state } });
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

export async function uploadWorkerArtifact(root, workerId, connectionId, runId, name, content) {
  if (!/^[a-f0-9-]{36}$/.test(runId) || !resultArtifacts.has(name)) throw new Error('Invalid worker artifact reference');
  const bytes = Buffer.isBuffer(content) ? content : Buffer.from(content);
  if (bytes.length > maxArtifactBytes) throw new Error('Worker output artifact is too large');
  const settings = loadS8Config(root).workerCommunicator, token = await readWorkerToken(root, workerId);
  const response = await fetch(`${settings.url}/v1/workers/${encodeURIComponent(workerId)}/artifacts/${runId}/${name}`, {
    method: 'PUT', headers: { authorization: `Bearer ${token}`, 'x-s8-connection-id': connectionId, 'content-type': 'application/octet-stream', 'x-artifact-sha256': createHash('sha256').update(bytes).digest('hex') },
    body: bytes, signal: AbortSignal.timeout(60_000),
  });
  const result = await response.json().catch(() => ({}));
  if (!response.ok) throw new Error(`Worker artifact upload HTTP ${response.status}: ${result.error ?? 'request_failed'}`);
  return result;
}

