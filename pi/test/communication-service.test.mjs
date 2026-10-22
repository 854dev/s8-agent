import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, writeFile, rm, readdir } from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import net from 'node:net';
import { runCommunicator } from '../lib/communication/service.mjs';
import { localRequest } from '../lib/communication/local.mjs';
import { registerCommunication } from '../extensions/communication.mjs';

const until = async check => { for (let i = 0; i < 300; i++) { if (await check()) return; await new Promise(resolve => setTimeout(resolve, 10)); } assert.fail('condition timeout'); };
async function fixture(t) {
  const managerRoot = await mkdtemp(path.join(os.tmpdir(), 's8-manager-'));
  const workerRoot = await mkdtemp(path.join(os.tmpdir(), 's8-remote-'));
  t.after(async () => { await rm(managerRoot, { recursive: true, force: true }); await rm(workerRoot, { recursive: true, force: true }); });
  const credentialsFile = path.join(managerRoot, 'secrets.json');
  await writeFile(credentialsFile, JSON.stringify({ workers: { a: 'a'.repeat(32), b: 'b'.repeat(32) } }), { mode: 0o600 });
  const reserve = net.createServer();
  await new Promise(resolve => reserve.listen(0, '127.0.0.1', resolve));
  const port = reserve.address().port;
  await new Promise(resolve => reserve.close(resolve));
  const config = { enabled: true, nodeId: 'manager-host', credentialsFile, server: { bindIp: '127.0.0.1', port }, managerUrl: `ws://127.0.0.1:${port}` };
  t.after(await runCommunicator(managerRoot, config));
  await writeFile(path.join(managerRoot, 's8-config.yml'), `communication:\n  enabled: true\n  nodeId: manager-host\n  credentialsFile: ${credentialsFile}\n  server:\n    port: ${port}\n`);
  const credential = path.join(workerRoot, 'secrets.json');
  await writeFile(credential, JSON.stringify({ workers: { a: 'a'.repeat(32), b: 'b'.repeat(32) } }), { mode: 0o600 });
  await writeFile(path.join(workerRoot, 's8-config.yml'), `communication:\n  enabled: true\n  nodeId: worker-host\n  credentialsFile: ${credential}\n  managerUrl: ${config.managerUrl}\n`);
  const peers = async () => (await localRequest(managerRoot, 'communicator', { action: 'peers' })).peers;
  return { managerRoot, workerRoot, peers };
}
async function session(t, root, role, workerId, taskUid) {
  const tools = new Map(), handlers = new Map(), entries = [];
  let idle = true;
  const ctx = { isIdle: () => idle, sessionManager: { getSessionId: () => `${workerId ?? role}-session`, getBranch: () => entries } };
  registerCommunication({
    on: (name, handler) => handlers.set(name, handler), registerTool: tool => tools.set(tool.name, tool),
    sendMessage: value => entries.push({ type: 'custom_message', ...value }),
  }, { root, role, workerId, taskUid });
  await handlers.get('session_start')({}, ctx);
  t.after(() => handlers.get('session_shutdown')());
  const send = args => tools.get('agent_message').execute('call', args, undefined, undefined, ctx).then(result => JSON.parse(result.content[0].text));
  return { entries, send, setIdle: value => { idle = value; } };
}

test('existing sessions exchange text across roots without a task, Projectman or resident worker', async t => {
  const f = await fixture(t);
  const manager = await session(t, f.managerRoot, 'manager');
  const worker = await session(t, f.workerRoot, 'worker', 'a');
  await until(async () => (await f.peers()).some(peer => peer.id === 'a' && peer.connected));
  const listed = await manager.send({ action: 'list' });
  assert.equal(listed.peers[0].id, 'a');
  assert.equal('mode' in listed.peers[0], false);
  worker.setIdle(false);
  const sent = await manager.send({ action: 'request', workerIds: ['a'], text: 'Which evidence applies?' });
  assert.equal(sent.results[0].state, 'pending');
  assert.equal(worker.entries.length, 0);
  worker.setIdle(true);
  await until(() => worker.entries.length === 1);
  const incoming = worker.entries[0].details.communication;
  const status = await manager.send({ action: 'status', workerIds: ['a'], requestId: sent.requestId });
  await until(async () => (await manager.send({ action: 'status', workerIds: ['a'], requestId: sent.requestId })).results[0].state === 'injected');
  assert.ok(['pending', 'injected'].includes(status.results[0].state));
  await worker.send({ action: 'reply', text: 'The documented acceptance condition.', requestId: incoming.requestId, replyTo: incoming.id });
  await until(() => manager.entries.length === 1);
  assert.equal(manager.entries[0].details.communication.from, 'a');
  const unavailable = await manager.send({ action: 'request', workerIds: ['b'], text: 'Hello' });
  assert.equal(unavailable.results[0].state, 'unavailable');
  assert.deepEqual((await readdir(path.join(f.workerRoot, '.s8-runtime')).catch(error => { if (error.code === 'ENOENT') return []; throw error; })).sort(), []);
});

test('fan-out delivers only to existing sessions and never creates research sessions', async t => {
  const f = await fixture(t);
  const manager = await session(t, f.managerRoot, 'manager');
  const a = await session(t, f.workerRoot, 'worker', 'a');
  const b = await session(t, f.workerRoot, 'worker', 'b');
  await until(async () => (await f.peers()).filter(peer => peer.connected).length === 2);
  const result = await manager.send({ action: 'request', workerIds: ['a', 'b'], text: 'Compare the evidence.' });
  assert.equal(result.results.every(item => item.state === 'pending'), true);
  assert.notEqual(result.results[0].requestId, result.results[1].requestId);
  await until(() => a.entries.length === 1 && b.entries.length === 1);
  assert.equal(a.entries[0].details.communication.groupId, result.groupId);
  assert.equal(b.entries[0].details.communication.groupId, result.groupId);
  await assert.rejects(a.send({ action: 'list' }), /Only Manager/);
  await assert.rejects(a.send({ action: 'notice', workerIds: ['b'], text: 'Bypass' }), /Manager only/);
  await assert.rejects(a.send({ action: 'notice', taskUid: 'other', text: 'Impersonate' }), /another task/);
});
