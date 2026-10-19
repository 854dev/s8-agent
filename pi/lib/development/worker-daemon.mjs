import { saveJson } from '../storage/json-file.mjs';
import path from 'node:path';
import { mkdir, readFile } from 'node:fs/promises';

import { executeDeveloper } from './worker-session.mjs';
import { executeClaudeDeveloper } from './worker-session-claude.mjs';
import { validWorkerId } from './worker-identity.mjs';
import { connectWorker, postWorkerState, postWorkerHeartbeat, pollWorkerMessage, acknowledgeWorkerMessage, uploadWorkerArtifact } from './worker-client.mjs';
import { workerStateFile } from './worker-store.mjs';
import { loadS8Config } from '../config/s8-config.mjs';
import { prepareWorkerWorkspace, uploadWorkerResults } from './worker-workspace.mjs';

export async function startDeveloperWorker(root, workerId, { executeWork, agent } = {}) {
  if (!validWorkerId(workerId)) throw new Error('Usage: developer.mjs <workerId>');
  const settings = loadS8Config(root), entry = settings.workerEntries[workerId] ?? { agent: agent ?? 'pi', host: 'local', launch: 'managed' };
  executeWork ??= entry.agent === 'claude-code' ? executeClaudeDeveloper : executeDeveloper;
  if (agent && entry.agent !== agent) throw new Error('Worker adapter does not match configured agent');
  const journal = path.join(root, '.s8-runtime/worker-daemons', `${workerId}.json`);
  await mkdir(path.dirname(journal), { recursive: true, mode: 0o700 });
  let previous;
  try { previous = JSON.parse(await readFile(journal, 'utf8')); }
  catch (error) {
    if (error.code !== 'ENOENT') throw error;
    // Read the old location once when upgrading; only the communicator writes it now.
    try { previous = JSON.parse(await readFile(workerStateFile(root, workerId), 'utf8')); }
    catch (legacyError) { if (legacyError.code !== 'ENOENT') throw legacyError; }
  }
  const interrupted = previous?.runId && ['busy', 'accepting', 'unknown'].includes(previous.status);
  const restored = previous ? { runId: previous.runId, uid: previous.uid, lastRunId: previous.lastRunId } : {};
  let state = interrupted
    ? { ...restored, workerId, status: 'unknown' }
    : previous?.status === 'reported'
      ? { ...restored, workerId, status: 'reported' }
      : { ...(previous?.lastRunId ? { lastRunId: previous.lastRunId } : {}), workerId, status: 'idle' };
  let connectionId, controller, shuttingDown = false, draining = false, drainAfterAck = false, activeExecution = Promise.resolve();
  let stateWrites = Promise.resolve();
  const pollController = new AbortController();
  const publishState = async snapshot => {
    if (!connectionId) throw Object.assign(new Error('Worker is disconnected'), { communication: true });
    const currentConnection = connectionId;
    try { await postWorkerState(root, workerId, currentConnection, snapshot); }
    catch (error) {
      if (connectionId === currentConnection) connectionId = undefined;
      error.communication = true;
      throw error;
    }
  };
  const saveState = (next, { publish = true } = {}) => {
    state = { ...next, workerId, agent: entry.agent, pid: process.pid };
    const snapshot = state;
    stateWrites = stateWrites.catch(() => {}).then(async () => {
      await saveJson(journal, snapshot);
      if (publish && connectionId) await publishState(snapshot);
    });
    return stateWrites;
  };
  await saveJson(journal, state);
  let reconnecting;
  function reconnect() {
    if (reconnecting) return reconnecting;
    const attempt = (async () => {
      const connected = await connectWorker(root, workerId, entry.agent);
      connectionId = connected.connectionId;
      try { await saveState(state); }
      catch (error) {
        if (state.status === 'accepting' && error.status === 409 && error.code !== 'stale_connection') {
          await saveState({ workerId, status: 'idle', lastRunId: state.lastRunId }, { publish: false });
        }
        throw error;
      }
    })();
    reconnecting = attempt.finally(() => { reconnecting = undefined; });
    return reconnecting;
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
      let failure;
      while (!shuttingDown) {
        if (controller.signal.aborted && !failure) failure = 'Work was canceled while preparing or uploading artifacts; local artifacts were preserved.';
        try {
          if (failure) {
            const report = { status: 'failed', summary: failure, executionErrors: [failure], verification: [], changedFiles: [] };
            await saveJson(path.join(runDirectory, 'worker-failure.json'), report);
            await uploadWorkerArtifact(root, workerId, connectionId, originalRequest.run.runId, 'worker-failure.json', JSON.stringify(report));
          } else {
            await uploadWorkerResults(root, workerId, connectionId, originalRequest, request, outcome, { signal: controller.signal });
          }
          break;
        } catch (error) {
          if (controller.signal.aborted && !failure) continue;
          if (error.permanent && !failure) {
            failure = 'Worker artifacts could not be exported or accepted; inspect the preserved workspace and run artifacts.';
            continue;
          }
          await reconnect().catch(() => {});
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
    const resumingAdmission = state.runId === command.runId && state.uid === command.uid && state.status === 'accepting';
    if (state.runId === command.runId && state.uid === command.uid && !resumingAdmission) return { accepted: true };
    if (state.lastRunId === command.runId) throw new Error('Assignment already finished');
    if (state.status !== 'idle' && !resumingAdmission) throw new Error('Worker is busy');
    let request = command.request;
    if (!request) {
      try { await readFile(path.join(root, '.s8-runtime/runs', command.runId, 'worker-result.json'), 'utf8'); throw new Error('Assignment has already finished'); }
      catch (error) { if (error.code !== 'ENOENT') throw error; }
      request = JSON.parse(await readFile(path.join(root, '.s8-runtime/runs', command.runId, 'request.json'), 'utf8'));
    }
    if (request.task?.uid !== command.uid || request.run?.runId !== command.runId || (request.workerId && request.workerId !== workerId)) throw new Error('Assignment mismatch');
    // Keep local admission pending until the central execution permission is confirmed.
    // A lost response is retried on the same in-memory admission, never treated as execution.
    await saveState({ ...state, status: 'accepting', uid: command.uid, runId: command.runId }, { publish: false });
    try { await publishState({ ...state, status: 'busy' }); }
    catch (error) {
      if (error.status === 409 && error.code !== 'stale_connection') {
        await saveState({ workerId, status: 'idle', lastRunId: state.lastRunId }, { publish: false });
      }
      throw error;
    }
    await saveState({ ...state, status: 'busy' }, { publish: false });
    activeExecution = execute(request).catch(() => { process.exitCode = 1; });
    return { accepted: true };
  }

  async function receiveLoop() {
    while (!shuttingDown) {
      let receivingConnection;
      try {
        if (!connectionId) await reconnect();
        receivingConnection = connectionId;
        const response = await pollWorkerMessage(root, workerId, receivingConnection, pollController.signal);
        if (receivingConnection !== connectionId) continue;
        if (!response?.message) continue;
        const { message } = response;
        await acknowledgeWorkerMessage(root, workerId, receivingConnection, message.messageId, 'received');
        let result;
        try { result = await handleCommand(message); }
        catch (error) {
          if (error.communication) throw error;
          result = { error: error.message === 'Worker is busy' || error.message === 'Assignment mismatch' ? error.message : 'Worker command rejected' };
        }
        await acknowledgeWorkerMessage(root, workerId, receivingConnection, message.messageId, 'processed', result);
        if (drainAfterAck) { drainAfterAck = false; await close(); }
      } catch {
        if (shuttingDown) break;
        if (!receivingConnection || receivingConnection === connectionId) connectionId = undefined;
        await new Promise(resolve => setTimeout(resolve, 1000));
      }
    }
  }

  const heartbeat = setInterval(() => {
    if (connectionId) {
      const currentConnection = connectionId;
      void postWorkerHeartbeat(root, workerId, currentConnection).catch(() => { if (connectionId === currentConnection) connectionId = undefined; });
    }
  }, 5000);
  void receiveLoop();
  console.log(`${workerId}: ${state.status}`);

  async function close() {
    if (shuttingDown) return;
    shuttingDown = true;
    pollController.abort();
    clearInterval(heartbeat);
    if (state.status === 'busy') controller?.abort();
    await stateWrites.catch(() => {});
  }

  return { close, state: () => state, wait: () => activeExecution };
}
