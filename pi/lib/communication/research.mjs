import path from 'node:path';
import { mkdir, realpath } from 'node:fs/promises';
import { ensureSession, ensureWindow, windows, runTmux, quote } from '../runtime/tmux-windows.mjs';
import { localRequest } from './local.mjs';

/** A separate Pi session/work directory; no existing task claim or permissions are reused. */
export async function startResearch(root, workerId, input, { run = runTmux } = {}) {
  root = await realpath(root);
  const name = `research-${workerId}-${input.requestId}`;
  const cwd = path.join(root, '.s8-runtime/research', workerId, input.requestId);
  const sessions = path.join(root, '.pi-runtime/research', workerId, input.requestId);
  await mkdir(cwd, { recursive: true, mode: 0o700 });
  await ensureSession(run, root, 's8-workers');
  const command = ['bash', path.join(root, 'start-worker-agent.sh'), '--request', input.requestId, '--cwd', cwd, '--session-dir', sessions].map(quote).join(' ');
  await ensureWindow(run, root, 's8-workers', name, `S8_WORKER_ID=${quote(workerId)} exec ${command}`);
  return { requestId: input.requestId, target: `s8-workers:${name}`, window: name };
}

export const researchAlive = async research => (await windows(runTmux, 's8-workers').catch(() => [])).some(window => window.name === research.window && !window.dead);
export const sendResearch = (root, workerId, research, input) => localRequest(root, `pi:${workerId}:${research.requestId}`, input);

export async function existingResearch(root, workerId, { run = runTmux } = {}) {
  root = await realpath(root);
  const prefix = `research-${workerId}-`;
  return (await windows(run, 's8-workers').catch(() => []))
    .filter(window => window.root === root && !window.dead && window.name.startsWith(prefix))
    .map(window => ({ requestId: window.name.slice(prefix.length), window: window.name, target: `s8-workers:${window.name}` }));
}
