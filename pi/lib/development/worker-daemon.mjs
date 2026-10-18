import { saveJson } from '../storage/json-file.mjs';
import net from 'node:net';
import path from 'node:path';
import { mkdir, readFile, rm, chmod } from 'node:fs/promises';

import { executeDeveloper } from './worker-session.mjs';
import { validWorker, workerDirectory, workerSocket, processAlive } from './worker-pool.mjs';

export async function startDeveloperWorker(root, workerId, { executeWork = executeDeveloper } = {}) {
  if (!validWorker(workerId)) throw new Error('Usage: developer.mjs worker-N');
  const directory = workerDirectory(root), socket = workerSocket(root, workerId), stateFile = path.join(directory, `${workerId}.json`);
  await mkdir(directory, { recursive: true, mode: 0o700 });
  let previous;
  try {
    previous = JSON.parse(await readFile(stateFile, 'utf8'));
    if (processAlive(previous.pid)) throw new Error('Worker already running');
  } catch (error) { if (error.code !== 'ENOENT') throw error; }
  await rm(socket, { force: true });
  let state = { ...(previous?.runId ? previous : {}), workerId, pid: process.pid, status: previous?.runId ? 'reported' : 'idle' }, controller, shuttingDown = false;
  const saveState = async next => { state = { ...next, workerId, pid: process.pid }; await saveJson(stateFile, state); };
  if (previous?.runId && previous.status !== 'reported') {
    await saveJson(path.join(root, '.s8-runtime/runs', previous.runId, 'worker-result.json'), { status: 'failed', summary: 'Worker process was interrupted; saved workspace and session remain available.', executionErrors: ['Worker stopped before its conversation finished'], verification: [] });
  }
  await saveState(state);
  async function execute(request) {
    controller = new AbortController();
    try {
      await executeWork(request, { signal: controller.signal });
    } catch {
      await saveJson(path.join(request.run.directory, 'worker-result.json'), { status: 'failed', summary: 'Worker execution failed or was interrupted; inspect the saved session and workspace.', executionErrors: ['Worker execution did not finish successfully'], verification: [], changedFiles: [] });
    }
    // The supervisor exports artifacts and confirms the server report before release.
    await saveState({ ...state, status: 'reported' });
    if (shuttingDown) await close();
  }
  const server = net.createServer({ allowHalfOpen: true }, client => {
    let input = '', handled = false;
    client.setTimeout(5000, () => client.destroy());
    client.on('error', () => {});
    client.on('data', async chunk => {
      input += chunk;
      if (input.length > 8192) { client.destroy(); return; }
      if (!input.includes('\n') || handled) return;
      handled = true;
      try {
        const command = JSON.parse(input);
        if (command.action === 'status') { client.end(JSON.stringify(state)); return; }
        if (command.action === 'cancel' && command.runId === state.runId) {
          controller?.abort(); client.end(JSON.stringify({ accepted: true })); return;
        }
        if (command.action === 'release' && command.runId === state.lastRunId) {
          client.end(JSON.stringify({ released: true })); return;
        }
        if (command.action === 'release' && command.runId === state.runId && state.status === 'reported') {
          await saveState({ status: 'idle', lastRunId: command.runId }); client.end(JSON.stringify({ released: true })); return;
        }
        if (command.action !== 'assign' || shuttingDown || !/^[a-f0-9-]{36}$/.test(command.runId ?? '') || !/^[a-zA-Z0-9_-]{1,120}$/.test(command.uid ?? '')) throw new Error('Invalid assignment');
        if (state.runId === command.runId && state.uid === command.uid) { client.end(JSON.stringify({ accepted: true })); return; }
        if (state.status !== 'idle') throw new Error('Worker is busy');
        // Reserve synchronously before reading request metadata so two requests cannot win.
        state = { ...state, status: 'accepting', uid: command.uid, runId: command.runId };
        try {
          await readFile(path.join(root, '.s8-runtime/runs', command.runId, 'worker-result.json'), 'utf8');
          throw new Error('Assignment has already finished');
        } catch (error) { if (error.code !== 'ENOENT') throw error; }
        const request = JSON.parse(await readFile(path.join(root, '.s8-runtime/runs', command.runId, 'request.json'), 'utf8'));
        if (request.task.uid !== command.uid || request.run.runId !== command.runId || request.workerId !== workerId) throw new Error('Assignment mismatch');
        await saveState({ ...state, status: 'busy' });
        client.end(JSON.stringify({ accepted: true }));
        void execute(request).catch(() => { process.exitCode = 1; void close(); });
      } catch {
        if (state.status === 'accepting') await saveState({ status: 'idle' });
        client.end(JSON.stringify({ error: 'Worker command rejected; inspect assignment and worker state' }));
      }
    });
  });
  async function close() { server.close(); await rm(socket, { force: true }); }
  await new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(socket, async () => {
      try { await chmod(socket, 0o600); resolve(); } catch (error) { reject(error); }
    });
  });
  console.log(`${workerId}: ${state.status}`);
  return { close: async () => {
    shuttingDown = true;
    if (state.status === 'busy') controller?.abort();
    else await close();
  }, state: () => state };
}
