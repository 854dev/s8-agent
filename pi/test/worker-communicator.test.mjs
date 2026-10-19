import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, rm, readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import net from 'node:net';
import { randomUUID } from 'node:crypto';
import { readWorkerToken } from '../lib/development/worker-auth.mjs';
import { acknowledgeWorkerMessage, connectWorker, postWorkerState, postWorkerHeartbeat } from '../lib/development/worker-client.mjs';
import { enqueueWorkerMessage, getWorkerState, waitForWorkerMessage, workerMessagesDirectory } from '../lib/development/worker-store.mjs';
import { startWorkerCommunicator } from '../lib/development/worker-communicator.mjs';

async function freePort() {
  const server = net.createServer();
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  const { port } = server.address();
  await new Promise(resolve => server.close(resolve));
  return port;
}

test('authenticated worker polling persists commands and replays unprocessed messages after reconnect', async t => {
  const root = await mkdtemp(path.join(os.tmpdir(), 's8-worker-communicator-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const port = await freePort(), workerId = 'remote-worker-1', entries = { [workerId]: { agent: 'claude-code', launch: 'external' } };
  const settings = { bindAddress: '127.0.0.1', port, url: `http://127.0.0.1:${port}` };
  await writeFile(path.join(root, 's8-config.yml'), `telegram: {}\nworker-entries:\n  ${workerId}:\n    agent: claude-code\n    launch: external\nworker-communicator:\n  bindAddress: 127.0.0.1\n  port: ${port}\n  url: ${settings.url}\n`);
  const server = await startWorkerCommunicator({ root, entries, settings });
  t.after(() => server.close());
  const token = await readWorkerToken(root, workerId), headers = { authorization: `Bearer ${token}`, 'content-type': 'application/json' };
  const unauthorized = await fetch(`${settings.url}/v1/workers/${workerId}/connect`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ protocolVersion: 1, workerId, agent: 'claude-code' }) });
  assert.equal(unauthorized.status, 401);
  const connection = await connectWorker(root, workerId, 'claude-code');
  await assert.rejects(connectWorker(root, workerId, 'pi'), /HTTP 400/);
  const { messageId } = await enqueueWorkerMessage(root, workerId, 'assign', { uid: 'task-1', runId: randomUUID() });
  const delivered = await fetch(`${settings.url}/v1/workers/${workerId}/poll?connectionId=${connection.connectionId}`, { headers });
  assert.equal(delivered.status, 200);
  const message = (await delivered.json()).message;
  assert.equal(message.messageId, messageId);
  await acknowledgeWorkerMessage(root, workerId, connection.connectionId, messageId, 'received');
  const replacement = await connectWorker(root, workerId, 'claude-code');
  const stale = await fetch(`${settings.url}/v1/workers/${workerId}/state`, { method: 'POST', headers, body: JSON.stringify({ connectionId: connection.connectionId, state: { status: 'idle' } }) });
  assert.equal(stale.status, 409);
  const replay = await fetch(`${settings.url}/v1/workers/${workerId}/poll?connectionId=${replacement.connectionId}`, { headers });
  assert.equal(replay.status, 200);
  assert.equal((await replay.json()).message.messageId, messageId);
  await acknowledgeWorkerMessage(root, workerId, replacement.connectionId, messageId, 'processed', { accepted: true });
  assert.deepEqual(await waitForWorkerMessage(root, workerId, messageId), { accepted: true });
  assert.equal((await getWorkerState(root, workerId)).connectionId, replacement.connectionId);
  const stored = JSON.parse(await readFile(path.join(workerMessagesDirectory(root, workerId), `${messageId}.json`), 'utf8'));
  assert.equal(stored.status, 'processed');
  assert.equal(stored.deliveryCount, 2);

  const assignment = { runId: message.payload.runId, uid: message.payload.uid };
  await postWorkerState(root, workerId, replacement.connectionId, { ...assignment, status: 'busy' });
  const directory = path.join(root, '.s8-runtime/runs', assignment.runId);
  await mkdir(directory, { recursive: true });
  await writeFile(path.join(directory, 'worker-result.json'), JSON.stringify({ status: 'failed', summary: 'fixture' }));
  await Promise.all([
    postWorkerState(root, workerId, replacement.connectionId, { ...assignment, status: 'reported' }),
    postWorkerHeartbeat(root, workerId, replacement.connectionId),
  ]);
  assert.equal((await getWorkerState(root, workerId)).status, 'reported', 'Heartbeat cannot overwrite a result state');
  await assert.rejects(postWorkerState(root, workerId, replacement.connectionId, { ...assignment, status: 'busy' }), /HTTP 409/);
  await postWorkerState(root, workerId, replacement.connectionId, { status: 'idle', lastRunId: assignment.runId });
  assert.equal((await getWorkerState(root, workerId)).runId, undefined, 'Release clears the previous assignment');

  await startWorkerCommunicator({ root, entries: {}, settings });
  await assert.rejects(connectWorker(root, workerId, 'claude-code'), /HTTP 401/, 'Removed worker IDs lose access');
});
