import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { createAgentSession, DefaultResourceLoader, SessionManager, SettingsManager, ModelRuntime } from '@earendil-works/pi-coding-agent';
import { sessionInbox } from '../lib/communication/session.mjs';

const message = (type, from, text, extra = {}) => ({ id: `${type}-${Math.random().toString(36).slice(2)}`, from, to: 'a', type, text, sentAt: new Date().toISOString(), ...extra });

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
  const injected = [];
  const settingsManager = SettingsManager.inMemory({ packages: [], retry: { enabled: false }, compaction: { enabled: false } });
  const loader = new DefaultResourceLoader({ cwd: root, agentDir: root, settingsManager, noExtensions: true, noSkills: true, noPromptTemplates: true, noContextFiles: true, noThemes: true, extensionFactories: [pi => {
    pi.on('session_start', (_event, ctx) => { inbox = sessionInbox(pi, ctx, { intervalMs: 10, onInjected: input => injected.push(input) }); });
  }] });
  await loader.reload();
  const sessionManager = SessionManager.create(root, path.join(root, 'sessions'));
  const { session } = await createAgentSession({ cwd: root, agentDir: root, modelRuntime: runtime, model: runtime.getModel('fixture', 'fixture'), resourceLoader: loader, settingsManager, sessionManager, tools: [] });
  await session.bindExtensions({ mode: 'print' });
  t.after(async () => { inbox.close(); await session.abort(); session.dispose(); });
  const firstTurn = session.prompt('Inspect the task.');
  await until(() => calls === 1);
  const input = message('request', 'manager', 'What evidence supports your conclusion?');
  assert.equal(inbox.receive(input), 'pending');
  assert.equal(inbox.receive(input), 'pending');
  assert.equal(sessionManager.getEntries().filter(entry => entry.type === 'custom_message').length, 0);
  release();
  await firstTurn;
  await until(() => calls === 2 && sessionManager.getEntries().some(entry => entry.type === 'custom_message'));
  await until(() => injected.length === 1);
  assert.equal(injected[0].id, input.id);
  assert.equal(inbox.receive(input), 'injected');
  const records = (await readFile(sessionManager.getSessionFile(), 'utf8')).trim().split('\n').map(JSON.parse);
  const custom = records.filter(entry => entry.type === 'custom_message');
  assert.equal(custom.length, 1);
  assert.equal(custom[0].details.communication.id, input.id);
  assert.equal(records.findIndex(entry => entry.type === 'message' && entry.message.role === 'assistant') < records.findIndex(entry => entry.type === 'custom_message'), true);
  // The same ID from another sender is a different message.
  assert.equal(inbox.receive({ ...input, from: 'other-manager' }), 'pending');
});

test('a busy session expires pending messages and rejects an unbounded inbox', async t => {
  const sessionManager = SessionManager.inMemory();
  const expired = [];
  const inbox = sessionInbox({ sendMessage() { assert.fail('busy session must not be interrupted'); } }, { sessionManager, isIdle: () => false }, { intervalMs: 5, ttlMs: 20, onExpired: input => expired.push(input) });
  t.after(() => inbox.close());
  const first = message('request', 'manager', 'Clarify');
  assert.equal(inbox.receive(first), 'pending');
  for (let i = 0; i < 99; i++) assert.equal(inbox.receive(message('notice', 'manager', `Notice ${i}`)), 'pending');
  assert.equal(inbox.receive(message('notice', 'manager', 'Overflow')).state, 'rejected');
  await until(() => expired.length === 100);
  assert.equal(expired[0].id, first.id);
});
