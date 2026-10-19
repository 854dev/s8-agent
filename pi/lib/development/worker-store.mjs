import { randomUUID } from 'node:crypto';
import path from 'node:path';
import { mkdir, readFile, readdir } from 'node:fs/promises';
import { saveJson } from '../storage/json-file.mjs';
import { validWorkerId } from './worker-identity.mjs';
import { protocolVersion } from './worker-protocol.mjs';

export const workerDirectory = root => path.join(root, '.s8-runtime/workers');
export const workerStateFile = (root, workerId) => path.join(workerDirectory(root), `${workerId}.json`);
export const workerMessagesDirectory = (root, workerId) => path.join(workerDirectory(root), 'messages', workerId);

const operations = new Map();
/** The supervisor and its HTTP server share one mutation queue per worker. */
export function withWorkerLock(root, workerId, operation) {
  const key = path.join(path.resolve(root), workerId);
  const previous = operations.get(key) ?? Promise.resolve();
  const next = previous.catch(() => {}).then(operation);
  operations.set(key, next);
  return next.finally(() => { if (operations.get(key) === next) operations.delete(key); });
}

export async function withdrawWorkerAssignment(root, workerId, runId) {
  return withWorkerLock(root, workerId, async () => {
    const state = await getWorkerState(root, workerId);
    // Once execution permission has been granted, a lost ACK is not a rejection.
    if (state?.runId === runId) return state;
    for (const message of await readWorkerMessages(root, workerId)) {
      if (message.value.type === 'assign' && message.value.payload?.runId === runId && message.value.status !== 'processed') {
        await saveJson(message.file, { ...message.value, status: 'canceled', response: { error: 'Assignment withdrawn before execution' } });
      }
    }
    if (state?.status === 'accepting' && state.assignedRunId === runId) {
      await saveJson(workerStateFile(root, workerId), { ...state, status: 'idle', assignedRunId: undefined, assignedUid: undefined });
    }
    return null;
  });
}

export async function getWorkerState(root, workerId) {
  try { return JSON.parse(await readFile(workerStateFile(root, workerId), 'utf8')); }
  catch (error) { if (error.code === 'ENOENT') return null; throw error; }
}

export async function readWorkerResult(directory) {
  try { return JSON.parse(await readFile(path.join(directory, 'worker-failure.json'), 'utf8')); }
  catch (error) { if (error.code !== 'ENOENT') throw error; }
  return JSON.parse(await readFile(path.join(directory, 'worker-result.json'), 'utf8'));
}

export async function readWorkerMessages(root, workerId) {
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

export async function waitForWorkerMessage(root, workerId, messageId, timeoutMs = 5000) {
  const file = path.join(workerMessagesDirectory(root, workerId), `${messageId}.json`);
  const until = Date.now() + timeoutMs;
  while (Date.now() < until) {
    try {
      const value = JSON.parse(await readFile(file, 'utf8'));
      if (['processed', 'canceled'].includes(value.status)) return value.response ?? { accepted: true };
    } catch (error) { if (error.code !== 'ENOENT') throw error; }
    await new Promise(resolve => setTimeout(resolve, 25));
  }
  throw new Error('Worker command acknowledgement timed out');
}
