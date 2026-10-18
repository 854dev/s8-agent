import path from 'node:path';
import { createHash } from 'node:crypto';
import { mkdir, readFile, readdir, realpath } from 'node:fs/promises';
import { ensureWindow, windows, withTmuxLock, runTmux, quote } from '../runtime/tmux-windows.mjs';
import { loadS8Config } from '../config/s8-config.mjs';
import { validWorkerId } from './worker-identity.mjs';
import { enqueueWorkerMessage, getWorkerState, waitForWorkerMessage } from './worker-communicator.mjs';
import { ensureRemoteWorker, stopRemoteWorkerIfExited } from './ssh-worker.mjs';

export { validWorkerId as validWorker };
export const workerDirectory = root => path.join(root, '.s8-runtime/workers');
export const processAlive = pid => {
  if (!Number.isSafeInteger(pid) || pid < 1) return false;
  try { process.kill(pid, 0); return true; } catch (error) { return error.code !== 'ESRCH'; }
};

export async function workerRequest(root, id, request, timeoutMs = 5000) {
  if (!validWorkerId(id)) throw new Error('Invalid worker ID');
  if (request.action === 'status') {
    const state = await getWorkerState(root, id);
    if (!state) throw new Error('Worker is offline');
    return state;
  }
  const { messageId } = await enqueueWorkerMessage(root, id, request.action, request);
  const result = await waitForWorkerMessage(root, id, messageId, timeoutMs);
  if (result?.error) throw new Error(result.error);
  return result;
}

const localPiWorker = entry => entry.agent === 'pi' && entry.host === 'local' && entry.launch === 'managed';

export async function workerStates(root, entries = loadS8Config(root).workerEntries) {
  let saved = [];
  try { saved = (await readdir(workerDirectory(root))).filter(name => name.endsWith('.json')).map(name => name.slice(0, -5)).filter(validWorkerId); }
  catch (error) { if (error.code !== 'ENOENT') throw error; }
  const ids = [...new Set([...Object.keys(entries), ...saved])];
  return Promise.all(ids.map(async workerId => {
    const config = entries[workerId];
    try {
      const state = JSON.parse(await readFile(path.join(workerDirectory(root), `${workerId}.json`), 'utf8'));
      const fresh = state.connected === true && Number.isFinite(Date.parse(state.lastSeenAt)) && Date.now() - Date.parse(state.lastSeenAt) < 15000;
      return { ...state, workerId, ...(config ? { agent: config.agent, launch: config.launch, host: config.host, registered: true } : { registered: false }), alive: fresh };
    } catch (error) {
      if (error.code !== 'ENOENT') throw error;
      return { workerId, ...(config ? { agent: config.agent, launch: config.launch, host: config.host, registered: true } : { registered: false }), alive: false, status: 'offline' };
    }
  }));
}

export async function ensureWorkerPool(root, { run = runTmux, ssh, entries = loadS8Config(root).workerEntries } = {}) {
  root = await realpath(root);
  const workerIds = Object.keys(entries).filter(id => localPiWorker(entries[id])).sort();
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
    let exists = false;
    try { await run(['has-session', '-t', `=${session}`]); exists = true; } catch {}
    if (!exists && !workerIds.length) return { session: null, count: Object.keys(entries).length, localCount: 0, workerIds, remoteWorkers, deferred: remoteDeferred };
    if (!exists) await run(['new-session', '-d', '-s', session, '-n', 'shell', '-c', root,
      ';', 'set-option', '-t', session, '@s8-runtime-root', root,
      ';', 'set-option', '-t', session, '@s8-managed', '1',
      ';', 'set-option', '-t', session, '@s8-role', 'workers']);
    const owner = (await run(['show-option', '-qv', '-t', session, '@s8-runtime-root'])).stdout.trim();
    if (owner !== root) throw new Error('Worker session belongs to another checkout');
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
        const fresh = state?.connected === true && Number.isFinite(Date.parse(state.lastSeenAt)) && Date.now() - Date.parse(state.lastSeenAt) < 15000;
        if (!fresh || state.status !== 'idle') { deferred = true; break; }
      }
    }
    if (deferred) return { session, count: current.length, localCount: current.length, workerIds: currentIds, deferred: true };
    await mkdir(workerDirectory(root), { recursive: true, mode: 0o700 });
    for (const item of current.filter(item => !workerIds.includes(item.name))) await run(['kill-window', '-t', item.id]);
    for (const id of workerIds) {
      const command = `exec bash ${quote(path.join(root, 'start-pi.sh'))} --service worker ${quote(id)}`;
      const window = await ensureWindow(run, root, session, id, command);
      await run(['set-option', '-w', '-t', window.id, '@s8-worker-id', id]);
    }
    return { session, count: Object.keys(entries).length, localCount: workerIds.length, workerIds, remoteWorkers, deferred: remoteDeferred };
  });
}
