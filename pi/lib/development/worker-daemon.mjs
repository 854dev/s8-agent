import { saveJson } from '../storage/json-file.mjs';
import path from 'node:path';
import { mkdir, readFile } from 'node:fs/promises';

import { executeDeveloper } from './worker-session.mjs';
import { executeClaudeDeveloper } from './worker-session-claude.mjs';
import { validWorkerId } from './worker-identity.mjs';
import { connectWorker, postWorkerState, pollWorkerMessage, acknowledgeWorkerMessage, workerStateFile } from './worker-communicator.mjs';
import { loadS8Config } from '../config/s8-config.mjs';
import { prepareWorkerWorkspace, uploadWorkerResults } from './worker-workspace.mjs';

export async function startDeveloperWorker(root, workerId, { executeWork, agent } = {}) {
  if (!validWorkerId(workerId)) throw new Error('Usage: developer.mjs <workerId>');
  const settings = loadS8Config(root), entry = settings.workerEntries[workerId] ?? { agent: agent ?? 'pi', host: 'local', launch: 'managed' };
  executeWork ??= entry.agent === 'claude-code' ? executeClaudeDeveloper : executeDeveloper;
  if (agent && entry.agent !== agent) throw new Error('Worker adapter does not match configured agent');
  await mkdir(path.join(root, '.s8-runtime/workers'), { recursive: true, mode: 0o700 });
  let previous;
  try { previous = JSON.parse(await readFile(workerStateFile(root, workerId), 'utf8')); }
  catch (error) { if (error.code !== 'ENOENT') throw error; }
  const interrupted = previous?.runId && ['busy', 'accepting'].includes(previous.status);
  let state = interrupted
    ? { ...previous, status: 'unknown', connectionId: undefined }
    : previous?.status === 'reported'
      ? { ...previous, workerId, status: 'reported' }
      : { ...(previous?.lastRunId ? { lastRunId: previous.lastRunId } : {}), workerId, status: 'idle' };
  let connectionId, controller, shuttingDown = false, draining = false, drainAfterAck = false, activeExecution = Promise.resolve();
  const pollController = new AbortController();
  const saveState = async next => {
    state = { ...next, workerId, agent: entry.agent, pid: process.pid, ...(connectionId ? { connectionId, connected: true, lastSeenAt: new Date().toISOString() } : { connected: false }) };
    await saveJson(workerStateFile(root, workerId), state);
    if (connectionId) await postWorkerState(root, workerId, connectionId, state);
  };
  await saveJson(workerStateFile(root, workerId), state);
  async function reconnect() {
    const connected = await connectWorker(root, workerId, entry.agent);
    connectionId = connected.connectionId;
    await saveState({ ...state, status: state.status === 'unknown' ? 'unknown' : state.status });
  }

  async function execute(originalRequest) {
    controller = new AbortController();
    const runDirectory = path.join(root, '.s8-runtime/runs', originalRequest.run.runId);
    const localRequest = originalRequest.transport?.kind === 'remote'
      ? { ...originalRequest, root, run: { ...originalRequest.run, directory: runDirectory, workspace: null } }
      : originalRequest;
    let request = localRequest, outcome;
    await mkdir(runDirectory, { recursive: true, mode: 0o700 });
    try {
      request = await prepareWorkerWorkspace(root, workerId, connectionId, localRequest);
      outcome = await executeWork(request, { signal: controller.signal });
    } catch {
      const directory = request.run?.directory;
      if (directory) await saveJson(path.join(directory, 'worker-result.json'), { status: 'failed', summary: 'Worker execution failed or was interrupted; inspect the saved session and workspace.', executionErrors: ['Worker execution did not finish successfully'], verification: [], changedFiles: [] });
    }
    if (originalRequest.transport?.kind === 'remote') {
      while (!shuttingDown) {
        try { await uploadWorkerResults(root, workerId, connectionId, originalRequest, request, outcome); break; }
        catch {
          if (!connectionId) await reconnect().catch(() => {});
          await new Promise(resolve => setTimeout(resolve, 1000));
        }
      }
      if (shuttingDown) {
        await saveState({ ...state, status: 'unknown' });
        return;
      }
    }
    await saveState({ ...state, status: 'reported' });
    if (shuttingDown) await close();
  }

  async function handleCommand(message) {
    const command = message.payload;
    if (!command || typeof command !== 'object') throw new Error('Invalid command');
    if (message.type === 'cancel') {
      if (command.runId !== state.runId) throw new Error('Assignment mismatch');
      controller?.abort();
      return { accepted: true };
    }
    if (message.type === 'release') {
      if (command.runId === state.lastRunId) return { released: true };
      if (command.runId !== state.runId || state.status !== 'reported') throw new Error('Worker is not ready to release');
      await saveState({ ...(draining ? {} : { workerId }), lastRunId: command.runId, status: draining ? 'stopping' : 'idle' });
      if (draining) drainAfterAck = true;
      return { released: true };
    }
    if (message.type === 'drain') {
      if (!['idle', 'busy', 'reported'].includes(state.status)) throw new Error('Worker state is unknown; inspect it before draining');
      draining = true;
      if (state.status === 'idle') {
        await saveState({ workerId, status: 'stopping' });
        drainAfterAck = true;
      }
      return { accepted: true, draining: true };
    }
    if (message.type !== 'assign' || shuttingDown || !/^[a-f0-9-]{36}$/.test(command.runId ?? '') || !/^[a-zA-Z0-9_-]{1,120}$/.test(command.uid ?? '')) throw new Error('Invalid assignment');
    if (state.runId === command.runId && state.uid === command.uid) return { accepted: true };
    if (state.lastRunId === command.runId) throw new Error('Assignment already finished');
    if (state.status !== 'idle') throw new Error('Worker is busy');
    state = { ...state, status: 'accepting', uid: command.uid, runId: command.runId };
    let request = command.request;
    if (!request) {
      try { await readFile(path.join(root, '.s8-runtime/runs', command.runId, 'worker-result.json'), 'utf8'); throw new Error('Assignment has already finished'); }
      catch (error) { if (error.code !== 'ENOENT') throw error; }
      request = JSON.parse(await readFile(path.join(root, '.s8-runtime/runs', command.runId, 'request.json'), 'utf8'));
    }
    if (request.task?.uid !== command.uid || request.run?.runId !== command.runId || (request.workerId && request.workerId !== workerId)) throw new Error('Assignment mismatch');
    await saveState({ ...state, status: 'busy' });
    activeExecution = execute(request).catch(() => { process.exitCode = 1; });
    return { accepted: true };
  }

  async function receiveLoop() {
    while (!shuttingDown) {
      try {
        if (!connectionId) await reconnect();
        const response = await pollWorkerMessage(root, workerId, connectionId, pollController.signal);
        if (!response?.message) continue;
        const { message } = response;
        await acknowledgeWorkerMessage(root, workerId, connectionId, message.messageId, 'received');
        let result;
        try { result = await handleCommand(message); }
        catch (error) { result = { error: error.message === 'Worker is busy' || error.message === 'Assignment mismatch' ? error.message : 'Worker command rejected' }; }
        await acknowledgeWorkerMessage(root, workerId, connectionId, message.messageId, 'processed', result);
        if (drainAfterAck) { drainAfterAck = false; await close(); }
      } catch {
        if (shuttingDown) break;
        connectionId = undefined;
        state = { ...state, connected: false, lastSeenAt: new Date().toISOString() };
        await new Promise(resolve => setTimeout(resolve, 1000));
      }
    }
  }

  const heartbeat = setInterval(() => {
    if (connectionId) void postWorkerState(root, workerId, connectionId, state).catch(() => { connectionId = undefined; });
  }, 5000);
  void receiveLoop();
  if (connectionId) await saveState(state);
  console.log(`${workerId}: ${state.status}`);

  async function close() {
    if (shuttingDown) return;
    shuttingDown = true;
    pollController.abort();
    clearInterval(heartbeat);
    if (state.status === 'busy') controller?.abort();
  }

  return { close, state: () => state, wait: () => activeExecution };
}
