import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, writeFile, rm } from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import net from 'node:net';
import { runCommunicator, connectResident } from '../lib/communication/service.mjs';
import { localRequest, listenLocal } from '../lib/communication/local.mjs';
import { registerCommunication } from '../extensions/communication.mjs';

const until = async check => { for (let i = 0; i < 200; i++) { if (await check()) return; await new Promise(resolve => setTimeout(resolve, 10)); } assert.fail('condition timeout'); };
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
  const send = (workerId, type, payload, context = {}) => localRequest(managerRoot, 'communicator', { action: 'send', workerId, type, payload, context }, { timeoutMs: 10_000 });
  return { managerRoot, workerRoot, config, send };
}

test('Manager delegates across independent roots; Worker questions and Manager follow-ups share the connection', async t => {
  const f = await fixture(t);
  // Worker has only its own credential and no shared runtime files.
  const credential = path.join(f.workerRoot, 'secrets.json');
  await writeFile(credential, JSON.stringify({ workers: { a: 'a'.repeat(32) } }), { mode: 0o600 });
  const worker = await connectResident(f.workerRoot, { ...f.config, nodeId: 'worker-host', credentialsFile: credential }, { id: 'a', mode: 'passive' });
  t.after(() => worker.close());
  await until(async () => (await localRequest(f.managerRoot, 'communicator', { action: 'workers' })).workers.length === 1);
  const task = await f.send('a', 'task.run', { uid: 'TASK-1' }, { taskUid: 'TASK-1', requestId: 'dispatch-1' });
  assert.equal(task.state, 'pending');
  assert.deepEqual(worker.nextInstruction(), { uid: 'TASK-1' });
  assert.equal(worker.nextInstruction(), null);
  const managerInbox = [], workerInbox = [];
  t.after(await listenLocal(f.managerRoot, 'pi:manager', async input => { managerInbox.push(input); return { state: 'pending' }; }));
  t.after(await listenLocal(f.workerRoot, 'pi:a:TASK-1', async input => { workerInbox.push(input); return { state: 'pending' }; }));
  const question = await localRequest(f.workerRoot, 'worker:a', { action: 'send', type: 'agent.request', payload: { text: 'Which acceptance condition applies?' }, context: { taskUid: 'TASK-1', requestId: 'question-1' } });
  assert.equal(question.state, 'pending');
  assert.equal(managerInbox[0].from, 'a');
  const reply = await f.send('a', 'agent.reply', { text: 'Can you show the conflicting evidence?' }, { taskUid: 'TASK-1', requestId: 'question-1', replyTo: managerInbox[0].id });
  assert.equal(reply.state, 'pending');
  assert.equal(workerInbox[0].from, 'manager');
});

test('parallel requests start separate temporary sessions and results return through Manager', async t => {
  const f = await fixture(t);
  const launched = [], received = [], managerInbox = [], residents = [];
  t.after(await listenLocal(f.managerRoot, 'pi:manager', async input => { managerInbox.push(input); return { state: 'pending' }; }));
  for (const id of ['a', 'b']) {
    const resident = await connectResident(f.workerRoot, f.config, { id, mode: 'passive' }, {
      launchResearch: async (root, workerId, input) => {
        launched.push({ workerId, requestId: input.requestId });
        t.after(await listenLocal(root, `pi:${workerId}:${input.requestId}`, async message => { received.push(message); return { state: 'pending' }; }));
        return { requestId: input.requestId, window: `research-${workerId}`, target: `s8-workers:research-${workerId}` };
      },
      isResearchAlive: async () => true,
    });
    residents.push(resident);
    t.after(() => resident.close());
  }
  await until(async () => (await localRequest(f.managerRoot, 'communicator', { action: 'workers' })).workers.length === 2);
  await writeFile(path.join(f.managerRoot, 's8-config.yml'), `communication:\n  enabled: true\n  nodeId: manager-host\n  credentialsFile: ${f.config.credentialsFile}\n  managerUrl: ${f.config.managerUrl}\n`);
  const tools = new Map();
  registerCommunication({ on() {}, registerTool(tool) { tools.set(tool.name, tool); } }, { root: f.managerRoot, role: 'manager' });
  const outcome = await tools.get('agent_message').execute('call', { action: 'request', workerIds: ['a', 'b'], text: 'Compare the evidence and state limitations.' }, undefined, undefined, { sessionManager: { getSessionId: () => 'manager-session' } });
  const result = JSON.parse(outcome.content[0].text);
  assert.equal(result.results.length, 2);
  assert.notEqual(result.results[0].requestId, result.results[1].requestId);
  assert.equal(received.every(input => input.groupId === result.groupId), true);
  assert.equal(residents.every(resident => resident.busy), true);
  for (const { workerId, requestId } of launched) {
    await localRequest(f.workerRoot, `worker:${workerId}`, { action: 'send', type: 'agent.result', payload: { text: `Evidence from ${workerId}` }, context: { requestId, groupId: result.groupId } });
  }
  assert.equal(managerInbox.length, 2);
  assert.equal(residents.every(resident => !resident.busy), true);
});

test('resident restart reconciles surviving research sessions before accepting unrelated work', async t => {
  const f = await fixture(t);
  const recovered = { requestId: 'old-request', window: 'research-a-old-request', target: 's8-workers:research-a-old-request' };
  t.after(await listenLocal(f.managerRoot, 'pi:manager', async () => ({ state: 'pending' })));
  t.after(await listenLocal(f.workerRoot, 'pi:a:old-request', async () => ({ state: 'pending' })));
  const worker = await connectResident(f.workerRoot, f.config, { id: 'a', mode: 'passive' }, {
    recoverResearch: async () => [recovered], isResearchAlive: async () => true,
    launchResearch: async () => { assert.fail('must not silently duplicate research after restart'); },
  });
  t.after(() => worker.close());
  await until(async () => (await localRequest(f.managerRoot, 'communicator', { action: 'workers' })).workers.length === 1);
  assert.equal(worker.busy, true);
  assert.equal((await f.send('a', 'agent.request', { text: 'Unrelated research' })).state, 'rejected');
  assert.equal((await f.send('a', 'agent.request', { text: 'Please confirm the old result.' }, { requestId: recovered.requestId })).state, 'pending');
  await localRequest(f.workerRoot, 'worker:a', { action: 'send', type: 'agent.result', payload: { text: 'Confirmed old findings' }, context: { requestId: recovered.requestId } });
  assert.equal(worker.busy, false);
});

test('an elapsed research response deadline notifies Manager without silently cancelling or reassigning work', async t => {
  const f = await fixture(t), received = [];
  t.after(await listenLocal(f.managerRoot, 'pi:manager', async input => { received.push(input); return { state: 'pending' }; }));
  const worker = await connectResident(f.workerRoot, f.config, { id: 'a', mode: 'passive' }, {
    intervalMs: 10, recoverResearch: async () => [], isResearchAlive: async () => true,
    launchResearch: async (root, id, input) => {
      t.after(await listenLocal(root, `pi:${id}:${input.requestId}`, async () => ({ state: 'pending' })));
      return { requestId: input.requestId, window: 'research-test', target: 's8-workers:research-test' };
    },
  });
  t.after(() => worker.close());
  await until(async () => (await localRequest(f.managerRoot, 'communicator', { action: 'workers' })).workers.length === 1);
  assert.equal((await f.send('a', 'agent.request', { text: 'Check evidence', deadlineAt: new Date(Date.now() - 1).toISOString() })).state, 'pending');
  await until(() => received.some(input => input.type === 'agent.notice' && input.payload.text.includes('deadline')));
  assert.equal(worker.busy, true);
  assert.equal(received.filter(input => input.payload.text.includes('deadline')).length, 1);
});

test('a queued request never inherits completion or failure from an earlier run of the same task', async t => {
  const { mkdir } = await import('node:fs/promises');
  const { randomUUID } = await import('node:crypto');
  const f = await fixture(t), oldRun = randomUUID(), newRun = randomUUID();
  const claims = path.join(f.workerRoot, '.s8-runtime/worker-claims');
  const oldDirectory = path.join(f.workerRoot, '.s8-runtime/runs', oldRun);
  await mkdir(claims, { recursive: true }); await mkdir(oldDirectory, { recursive: true });
  const claimFile = path.join(claims, 'task-1.json');
  await writeFile(claimFile, JSON.stringify({ uid: 'task-1', runId: oldRun, revision: 2, reported: true }));
  await writeFile(path.join(oldDirectory, 'outbox.json'), '{"delivered":true}');
  const stateDirectory = path.join(f.workerRoot, '.s8-runtime/workers/a');
  await mkdir(stateDirectory, { recursive: true });
  await writeFile(path.join(stateDirectory, 'state.json'), JSON.stringify({ lastError: { uid: 'task-1', message: 'Old failure', at: new Date(Date.now() - 1000).toISOString() } }));
  const worker = await connectResident(f.workerRoot, f.config, { id: 'a', mode: 'passive' });
  t.after(() => worker.close());
  await until(async () => (await localRequest(f.managerRoot, 'communicator', { action: 'workers' })).workers.length === 1);
  await f.send('a', 'task.run', { uid: 'task-1' }, { taskUid: 'task-1', requestId: 'new-request' });
  const status = () => f.send('a', 'request.status', { requestId: 'new-request' }, { taskUid: 'task-1' });
  assert.equal((await status()).state, 'pending');
  worker.nextInstruction();
  assert.equal((await status()).state, 'accepted');
  await writeFile(claimFile, JSON.stringify({ uid: 'task-1', runId: newRun, revision: 3, reported: false }));
  const claimed = await status();
  assert.equal(claimed.state, 'claimed');
  assert.equal(claimed.runId, newRun);
  await f.send('a', 'task.run', { uid: 'task-1' }, { taskUid: 'task-1', requestId: 'resume-request' });
  worker.nextInstruction();
  const resumed = await f.send('a', 'request.status', { requestId: 'resume-request' }, { taskUid: 'task-1' });
  assert.equal(resumed.state, 'claimed');
  assert.equal(resumed.runId, newRun);
});
