import path from 'node:path';
import { createHash } from 'node:crypto';
import { mkdir, readdir, realpath } from 'node:fs/promises';
import { ensureSession, ensureWindow, hasSession, windows, withTmuxLock, runTmux, quote } from '../runtime/tmux-windows.mjs';
import { loadS8Config } from '../config/s8-config.mjs';
import { validWorkerId } from './worker-identity.mjs';
import { enqueueWorkerMessage, getWorkerState, waitForWorkerMessage, withdrawWorkerAssignment, workerDirectory } from './worker-store.mjs';
import { ensureRemoteWorker, stopRemoteWorkerIfExited } from './ssh-worker.mjs';
import { workerStateIsFresh } from './worker-protocol.mjs';

export async function workerRequest(root, id, request, timeoutMs = 5000) {
  if (!validWorkerId(id)) throw new Error('Invalid worker ID');
  if (request.action === 'status') {
    const state = await getWorkerState(root, id);
    if (!state) throw new Error('Worker is offline');
    return state;
  }
  const { messageId } = await enqueueWorkerMessage(root, id, request.action, request);
  let result;
  try { result = await waitForWorkerMessage(root, id, messageId, timeoutMs); }
  catch (error) {
    if (request.action === 'assign') await withdrawWorkerAssignment(root, id, request.runId);
    throw error;
  }
  if (result?.error) throw new Error(result.error);
  return result;
}

const localManagedWorker = entry => entry.host === 'local' && entry.launch === 'managed';

export async function workerStates(root, entries = loadS8Config(root).workerEntries) {
  let saved = [];
  try { saved = (await readdir(workerDirectory(root))).filter(name => name.endsWith('.json')).map(name => name.slice(0, -5)).filter(validWorkerId); }
  catch (error) { if (error.code !== 'ENOENT') throw error; }
  const ids = [...new Set([...Object.keys(entries), ...saved])];
  return Promise.all(ids.map(async workerId => {
    const config = entries[workerId];
    const state = await getWorkerState(root, workerId);
    if (state) {
      const fresh = workerStateIsFresh(state);
      return { ...state, workerId, ...(config ? { agent: config.agent, launch: config.launch, host: config.host, registered: true } : { registered: false }), alive: fresh };
    }
    return { workerId, ...(config ? { agent: config.agent, launch: config.launch, host: config.host, registered: true } : { registered: false }), alive: false, status: 'offline' };
  }));
}

/** 작업 중이거나 상태를 알 수 없는 워커가 있으면 true. 종료가 끝난(프로세스 없는 stopping) 워커는 제외한다. */
export async function workersBusy(root) {
  return (await workerStates(root)).some(worker => worker.status !== 'idle' && worker.status !== 'offline' && !(worker.status === 'stopping' && !worker.alive));
}

export async function ensureWorkerPool(root, { run = runTmux, ssh, entries = loadS8Config(root).workerEntries } = {}) {
  root = await realpath(root);
  const workerIds = Object.keys(entries).filter(id => localManagedWorker(entries[id])).sort();
  const remoteEntries = Object.entries(entries).filter(([, entry]) => entry.launch === 'managed' && entry.host?.startsWith('ssh://'));
  const remoteWorkers = await Promise.all(remoteEntries.map(([workerId, entry]) => ensureRemoteWorker(workerId, entry, ssh ? { exec: ssh } : {})));
  let remoteDeferred = false;
  const savedStates = await workerStates(root, entries);
  for (const state of savedStates.filter(value => !value.registered && value.launch === 'managed' && value.host?.startsWith('ssh://'))) {
    if (state.status === 'stopping') {
      const stopped = await stopRemoteWorkerIfExited(state.workerId, { host: state.host, root: state.root }, ssh ? { exec: ssh } : {});
      if (stopped.status === 'active' || stopped.status === 'unreachable') remoteDeferred = true;
      continue;
    }
    if (state.alive && ['idle', 'busy', 'reported'].includes(state.status)) {
      await workerRequest(root, state.workerId, { action: 'drain' }).catch(() => {});
    }
    remoteDeferred = true;
  }
  const session = `s8-workers-${createHash('sha256').update(root).digest('hex').slice(0, 8)}`;
  return withTmuxLock(run, `${session}-lock`, async () => {
    if (!workerIds.length && !await hasSession(run, session)) return { session: null, count: Object.keys(entries).length, localCount: 0, workerIds, remoteWorkers, deferred: remoteDeferred };
    await ensureSession(run, root, session, { '@s8-role': 'workers' });
    const current = (await windows(run, session)).filter(item => item.workerId || workerIds.includes(item.name) || /^worker-[1-9]\d*$/.test(item.name));
    for (const item of current) if (item.root !== root) throw new Error('Worker window belongs to another checkout');
    const currentIds = current.map(item => item.name).sort();
    const changed = JSON.stringify(currentIds) !== JSON.stringify(workerIds);
    let deferred = false;
    if (changed && current.some(item => !item.dead)) {
      for (const item of current.filter(item => !item.dead)) {
        let state;
        try { state = await getWorkerState(root, item.workerId ?? item.name); }
        catch { deferred = true; break; }
        const fresh = workerStateIsFresh(state);
        if (!fresh || state.status !== 'idle') { deferred = true; break; }
      }
    }
    if (deferred) return { session, count: current.length, localCount: current.length, workerIds: currentIds, deferred: true };
    await mkdir(workerDirectory(root), { recursive: true, mode: 0o700 });
    for (const item of current.filter(item => !workerIds.includes(item.name))) await run(['kill-window', '-t', item.id]);
    for (const id of workerIds) {
      const command = `exec bash ${quote(path.join(root, 's8.sh'))} service worker ${quote(id)}`;
      const window = await ensureWindow(run, root, session, id, command);
      await run(['set-option', '-w', '-t', window.id, '@s8-worker-id', id]);
    }
    return { session, count: Object.keys(entries).length, localCount: workerIds.length, workerIds, remoteWorkers, deferred: remoteDeferred };
  });
}
