import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { createAgentSession, DefaultResourceLoader, SessionManager, SettingsManager, ModelRuntime } from '@earendil-works/pi-coding-agent';
import { sessionInbox } from '../lib/communication/session.mjs';
import { message } from '../lib/communication/protocol.mjs';
import { localRequest, listenLocal } from '../lib/communication/local.mjs';

const until = async check => { for (let i = 0; i < 200; i++) { if (await check()) return; await new Promise(resolve => setTimeout(resolve, 10)); } assert.fail('condition timeout'); };

test('installed Pi SDK waits for the active turn, then persists one correlated custom message', async t => {
  const root = await mkdtemp(path.join(os.tmpdir(), 's8-pi-communication-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  let release, calls = 0;
  const gate = new Promise(resolve => { release = resolve; });
  const provider = http.createServer(async (req, res) => {
    for await (const _chunk of req) { /* consume body */ }
    calls++;
    if (calls === 1) await gate;
    res.writeHead(200, { 'content-type': 'text/event-stream' });
    for (const [delta, finish_reason] of [[{ role: 'assistant', content: 'Evidence checked.' }, null], [{}, 'stop']]) {
      res.write(`data: ${JSON.stringify({ id: 'test', object: 'chat.completion.chunk', model: 'fixture', choices: [{ index: 0, delta, finish_reason }] })}\n\n`);
    }
    res.end('data: [DONE]\n\n');
  });
  await new Promise(resolve => provider.listen(0, '127.0.0.1', resolve));
  t.after(async () => { release(); provider.closeAllConnections(); await new Promise(resolve => provider.close(resolve)); });
  const runtime = await ModelRuntime.create({ authPath: path.join(root, 'auth.json'), modelsPath: path.join(root, 'models.json'), refreshOnCreate: false });
  runtime.registerProvider('fixture', { api: 'openai-completions', apiKey: 'fixture-key', baseUrl: `http://127.0.0.1:${provider.address().port}`, models: [{ id: 'fixture', name: 'Fixture', reasoning: false, input: ['text'], contextWindow: 32768, maxTokens: 1024, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 } }] });
  let inbox;
  const settingsManager = SettingsManager.inMemory({ packages: [], retry: { enabled: false }, compaction: { enabled: false } });
  const loader = new DefaultResourceLoader({ cwd: root, agentDir: root, settingsManager, noExtensions: true, noSkills: true, noPromptTemplates: true, noContextFiles: true, noThemes: true, extensionFactories: [pi => {
    pi.on('session_start', (_event, ctx) => { inbox = sessionInbox(pi, ctx, { role: 'worker', taskUid: 'task-1', intervalMs: 10 }); });
  }] });
  await loader.reload();
  const sessionManager = SessionManager.create(root, path.join(root, 'sessions'));
  const { session } = await createAgentSession({ cwd: root, agentDir: root, modelRuntime: runtime, model: runtime.getModel('fixture', 'fixture'), resourceLoader: loader, settingsManager, sessionManager, tools: [] });
  await session.bindExtensions({ mode: 'print' });
  t.after(async () => { inbox.close(); await session.abort(); session.dispose(); });
  const firstTurn = session.prompt('Inspect the task.');
  await until(() => calls === 1);
  const input = message('agent.request', 'manager', 'a', { text: 'What evidence supports your conclusion?' }, { taskUid: 'task-1', sessionId: sessionManager.getSessionId() });
  assert.equal(inbox.receive(input).state, 'pending');
  assert.equal(inbox.receive(input).state, 'pending');
  assert.equal(sessionManager.getEntries().filter(entry => entry.type === 'custom_message').length, 0);
  release();
  await firstTurn;
  await until(() => calls === 2 && sessionManager.getEntries().some(entry => entry.type === 'custom_message'));
  const query = message('request.status', 'manager', 'a', { requestId: input.requestId }, { taskUid: 'task-1' });
  await until(() => inbox.receive(query).state === 'injected');
  assert.equal(inbox.receive(input).state, 'injected');
  const records = (await readFile(sessionManager.getSessionFile(), 'utf8')).trim().split('\n').map(JSON.parse);
  const custom = records.filter(entry => entry.type === 'custom_message');
  assert.equal(custom.length, 1);
  assert.equal(custom[0].details.communication.id, input.id);
  assert.equal(records.findIndex(entry => entry.type === 'message' && entry.message.role === 'assistant') < records.findIndex(entry => entry.type === 'custom_message'), true);
  assert.equal(inbox.receive({ ...input, id: 'different', sessionId: 'stale-session' }).state, 'rejected');
});

test('local IPC returns unavailable, protects active endpoints and exchanges bounded JSON', async t => {
  const root = await mkdtemp(path.join(os.tmpdir(), 's8-ipc-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  assert.equal((await localRequest(root, 'missing', {})).state, 'unavailable');
  const close = await listenLocal(root, 'test', async input => ({ state: 'finished', value: input.value }));
  t.after(close);
  assert.deepEqual(await localRequest(root, 'test', { value: 42 }), { state: 'finished', value: 42 });
  await assert.rejects(listenLocal(root, 'test', () => ({})), /already running/);
});

test('a busy session expires pending requests and rejects an unbounded inbox', async t => {
  const sessionManager = SessionManager.inMemory();
  const inbox = sessionInbox({ sendMessage() { assert.fail('busy session must not be interrupted'); } }, { sessionManager, isIdle: () => false }, { role: 'worker', taskUid: 'task-1', intervalMs: 5 });
  t.after(() => inbox.close());
  const first = message('agent.request', 'manager', 'a', { text: 'Clarify' }, { taskUid: 'task-1', expiresAt: new Date(Date.now() + 20).toISOString() });
  assert.equal(inbox.receive(first).state, 'pending');
  for (let i = 0; i < 99; i++) assert.equal(inbox.receive(message('agent.notice', 'manager', 'a', { text: `Notice ${i}` }, { taskUid: 'task-1' })).state, 'pending');
  assert.equal(inbox.receive(message('agent.notice', 'manager', 'a', { text: 'Overflow' }, { taskUid: 'task-1' })).state, 'rejected');
  await new Promise(resolve => setTimeout(resolve, 30));
  const status = message('request.status', 'manager', 'a', { requestId: first.requestId }, { taskUid: 'task-1' });
  assert.equal(inbox.receive(status).state, 'timeout');
});
