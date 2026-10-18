import net from 'node:net';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { mkdir, readFile, readdir, realpath } from 'node:fs/promises';
import { ensureWindow, windows, withTmuxLock, runTmux, quote } from '../runtime/tmux-windows.mjs';
import { loadS8Config } from '../config/s8-config.mjs';

export const workerDirectory = root => path.join(root, '.s8-runtime/workers');
export const workerSocket = (root, id) => path.join(workerDirectory(root), `${id}.sock`);
export const validWorker = id => /^worker-[1-9]\d*$/.test(id ?? '');
export const processAlive = pid => {
  if (!Number.isSafeInteger(pid) || pid < 1) return false;
  try { process.kill(pid, 0); return true; } catch (error) { return error.code !== 'ESRCH'; }
};

export function workerRequest(root, id, request, timeoutMs = 5000) {
  if (!validWorker(id)) throw new Error('Invalid worker ID');
  return new Promise((resolve, reject) => {
    const socket = net.connect(workerSocket(root, id));
    let buffer = '';
    socket.setTimeout(timeoutMs, () => socket.destroy(new Error('Worker control timeout')));
    socket.on('error', reject);
    socket.on('connect', () => socket.end(`${JSON.stringify(request)}\n`));
    socket.on('data', data => {
      buffer += data;
      if (buffer.length > 65536) socket.destroy(new Error('Worker response too large'));
    });
    socket.on('end', () => {
      try { const result = JSON.parse(buffer); result.error ? reject(new Error(result.error)) : resolve(result); }
      catch (error) { reject(error); }
    });
  });
}

export async function workerStates(root, count = loadS8Config(root).workers.count) {
  let saved = [];
  try { saved = (await readdir(workerDirectory(root))).filter(name => name.endsWith('.json')).map(name => name.slice(0, -5)).filter(validWorker); }
  catch (error) { if (error.code !== 'ENOENT') throw error; }
  const ids = [...new Set([...Array.from({ length: count }, (_, i) => `worker-${i + 1}`), ...saved])];
  return Promise.all(ids.map(async workerId => {
    try {
      const state = JSON.parse(await readFile(path.join(workerDirectory(root), `${workerId}.json`), 'utf8'));
      return { ...state, workerId, alive: processAlive(state.pid) };
    } catch (error) {
      if (error.code !== 'ENOENT') throw error;
      return { workerId, alive: false, status: 'offline' };
    }
  }));
}

export async function ensureWorkerPool(root, { run = runTmux, count = loadS8Config(root).workers.count } = {}) {
  root = await realpath(root);
  if (!Number.isSafeInteger(count) || count < 1) throw new Error('Invalid worker count');
  const session = `s8-workers-${createHash('sha256').update(root).digest('hex').slice(0, 8)}`;
  return withTmuxLock(run, `${session}-lock`, async () => {
    let exists = false;
    try { await run(['has-session', '-t', `=${session}`]); exists = true; } catch {}
    if (!exists) await run(['new-session', '-d', '-s', session, '-n', 'shell', '-c', root,
      ';', 'set-option', '-t', session, '@s8-runtime-root', root,
      ';', 'set-option', '-t', session, '@s8-managed', '1',
      ';', 'set-option', '-t', session, '@s8-role', 'workers']);
    const owner = (await run(['show-option', '-qv', '-t', session, '@s8-runtime-root'])).stdout.trim();
    if (owner !== root) throw new Error('Worker session belongs to another checkout');
    const current = (await windows(run, session)).filter(item => validWorker(item.name));
    for (const item of current) if (item.root !== root) throw new Error('Worker window belongs to another checkout');
    let deferred = false;
    if (current.length !== count && current.some(item => !item.dead)) {
      for (const item of current.filter(item => !item.dead)) {
        let state;
        try { state = await workerRequest(root, item.name, { action: 'status' }); }
        catch { deferred = true; break; }
        if (state.status !== 'idle') { deferred = true; break; }
      }
    }
    if (deferred) return { session, count: current.length, deferred: true };
    await mkdir(workerDirectory(root), { recursive: true, mode: 0o700 });
    for (const item of current.filter(item => Number(item.name.slice(7)) > count)) await run(['kill-window', '-t', item.id]);
    for (let index = 1; index <= count; index++) {
      const id = `worker-${index}`;
      const command = `exec bash ${quote(path.join(root, 'start-pi.sh'))} --service worker ${quote(id)}`;
      await ensureWindow(run, root, session, id, command);
    }
    return { session, count, deferred: false };
  });
}
