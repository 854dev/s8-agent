// Owner-only Unix sockets join the resident/communicator processes to local Pi sessions.
import net from 'node:net';
import { createHash } from 'node:crypto';
import { chmod, lstat, mkdir, unlink } from 'node:fs/promises';
import path from 'node:path';
import { MAX_BYTES, MAX_PENDING } from './protocol.mjs';

export const socketPath = (root, name) => path.join(root, '.s8-runtime/communication', `${createHash('sha256').update(name).digest('hex').slice(0, 20)}.sock`);

export async function localRequest(root, name, value, { timeoutMs = 5000 } = {}) {
  return new Promise(resolve => {
    const socket = net.createConnection(socketPath(root, name));
    let buffer = '', settled = false;
    const finish = result => { if (!settled) { settled = true; socket.destroy(); resolve(result); } };
    socket.setTimeout(timeoutMs, () => finish({ state: 'unknown', reason: 'Local request timed out' }));
    socket.on('connect', () => socket.write(`${JSON.stringify(value)}\n`));
    socket.on('data', data => {
      buffer += data.toString();
      if (Buffer.byteLength(buffer) > MAX_BYTES) return finish({ state: 'rejected', reason: 'Local response too large' });
      if (buffer.includes('\n')) {
        try { finish(JSON.parse(buffer.split('\n')[0])); }
        catch { finish({ state: 'unknown', reason: 'Invalid local response' }); }
      }
    });
    socket.on('error', error => finish({ state: ['ENOENT', 'ECONNREFUSED'].includes(error.code) ? 'unavailable' : 'unknown' }));
    socket.on('close', () => finish({ state: 'unknown' }));
  });
}

export async function listenLocal(root, name, handle) {
  const file = socketPath(root, name);
  await mkdir(path.dirname(file), { recursive: true, mode: 0o700 });
  await chmod(path.dirname(file), 0o700);
  try {
    const stat = await lstat(file);
    if (!stat.isSocket()) throw new Error('Communication: local endpoint is not a socket');
    if ((await localRequest(root, name, { action: 'ping' })).state !== 'unavailable') throw new Error('Communication: local endpoint already running');
    await unlink(file);
  } catch (error) { if (error.code !== 'ENOENT') throw error; }
  const connections = new Set();
  const server = net.createServer(socket => {
    if (connections.size >= MAX_PENDING) { socket.destroy(); return; }
    connections.add(socket);
    socket.on('close', () => connections.delete(socket));
    socket.on('error', () => {});
    socket.setTimeout(35_000, () => socket.destroy());
    let buffer = '', handling = false;
    socket.on('data', async data => {
      if (handling) return;
      buffer += data.toString();
      if (Buffer.byteLength(buffer) > MAX_BYTES) { socket.destroy(); return; }
      if (!buffer.includes('\n')) return;
      handling = true;
      let result;
      try { result = await handle(JSON.parse(buffer.split('\n')[0])); }
      catch { result = { state: 'rejected', reason: 'Local request failed' }; }
      if (!socket.destroyed) socket.end(`${JSON.stringify(result)}\n`);
    });
  });
  await new Promise((resolve, reject) => { server.once('error', reject); server.listen(file, resolve); });
  await chmod(file, 0o600);
  return async () => {
    for (const socket of connections) socket.destroy();
    await new Promise(resolve => server.close(resolve));
    await unlink(file).catch(error => { if (error.code !== 'ENOENT') throw error; });
  };
}
