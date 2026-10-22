import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, writeFile, chmod, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { WebSocket } from 'ws';
import { startCommunicationServer } from '../lib/communication/server.mjs';
import { startWorkerConnection } from '../lib/communication/client.mjs';
import { readCredentials } from '../lib/communication/credentials.mjs';

const until = async check => { for (let i = 0; i < 100; i++) { if (await check()) return; await new Promise(resolve => setTimeout(resolve, 10)); } assert.fail('condition timeout'); };
async function fixture(t, options = {}) {
  const root = await mkdtemp(path.join(os.tmpdir(), 's8-network-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const credentialsFile = path.join(root, 'credentials.json');
  await writeFile(credentialsFile, JSON.stringify({ workers: { a: 'a'.repeat(32), b: 'b'.repeat(32) } }), { mode: 0o600 });
  const config = { nodeId: 'test-host', credentialsFile, server: { bindIp: '127.0.0.1', port: 0 } };
  const server = await startCommunicationServer(config, options);
  t.after(() => server.close());
  config.managerUrl = `ws://127.0.0.1:${server.address.port}`;
  return { config, server };
}

test('real WebSocket connects two Workers and supports Manager-mediated questions and replies', async t => {
  const questions = [], assignments = [], events = [];
  const { config, server } = await fixture(t, { onMessage: async input => { questions.push(input); return { state: 'pending' }; }, onEvent: event => events.push(event) });
  const a = await startWorkerConnection(config, 'a', { onMessage: async input => { assignments.push(input); return { state: 'accepted' }; } });
  const b = await startWorkerConnection(config, 'b', { onMessage: async () => ({ state: 'injected' }) });
  t.after(async () => { await a.close(); await b.close(); });
  await until(() => server.peers().length === 2 && a.connected && b.connected);
  assert.equal((await server.request('a', 'agent.request', { text: 'Please check the evidence.' })).state, 'accepted');
  assert.equal(assignments[0].from, 'manager');
  assert.equal((await a.request('agent.request', { text: 'Please ask B to review.' })).state, 'pending');
  assert.equal(questions.length, 1);
  assert.equal(questions[0].to, 'manager');
  assert.equal((await server.request('b', 'agent.request', { text: 'Review A’s findings.' })).state, 'injected');
  assert.equal((await server.request('missing', 'agent.request', { text: 'Hello' })).state, 'unavailable');
  assert.equal(server.peers().find(worker => worker.id === 'a').metrics.sent, 1);
  assert.equal(events.some(event => event.direction === 'receipt' && event.latencyMs >= 0), true);
  assert.equal(JSON.stringify(events).includes('Please ask B to review.'), false, 'transport logs contain metadata, not conversations');
});

test('disconnect produces unknown and reconnect does not replay an ambiguous request', async t => {
  const { config, server } = await fixture(t, { timeoutMs: 50 });
  let calls = 0;
  const a = await startWorkerConnection(config, 'a', { onMessage: () => { calls++; return new Promise(() => {}); } });
  t.after(() => a.close());
  await until(() => a.connected);
  const pending = server.request('a', 'agent.request', { text: 'Research' });
  await until(() => calls === 1);
  await a.close();
  assert.equal((await pending).state, 'unknown');
  const next = await startWorkerConnection(config, 'a', { onMessage: async () => { calls++; return { state: 'accepted' }; } });
  t.after(() => next.close());
  await until(() => next.connected);
  assert.equal(calls, 1);
});

test('authentication, browser access and duplicate Worker identity are rejected', async t => {
  const { config, server } = await fixture(t);
  async function rejected(headers) {
    const ws = new WebSocket(config.managerUrl, { headers });
    ws.on('error', () => {});
    const code = await new Promise(resolve => ws.on('unexpected-response', (_req, response) => { resolve(response.statusCode); response.destroy(); ws.terminate(); }));
    return code;
  }
  const headers = { authorization: `Bearer ${'a'.repeat(32)}`, 'x-s8-worker': 'a', 'x-s8-node': 'host', 'x-s8-version': '2' };
  assert.equal(await rejected({ ...headers, authorization: 'Bearer wrong' }), 401);
  assert.equal(await rejected({ ...headers, origin: 'http://browser.invalid' }), 401);
  assert.equal(await rejected({ ...headers, 'x-s8-version': '1' }), 401);
  const a = await startWorkerConnection(config, 'a', { onMessage: async () => ({ state: 'accepted' }) });
  t.after(() => a.close());
  await until(() => server.peers().length === 1);
  assert.equal(await rejected(headers), 409);
});

test('credential files require restrictive permissions and never expose invalid contents', async t => {
  const { config } = await fixture(t);
  await chmod(config.credentialsFile, 0o644);
  await assert.rejects(readCredentials(config.credentialsFile), /private regular/);
  await chmod(config.credentialsFile, 0o600);
  await writeFile(config.credentialsFile, '{"workers":{"a":"fixture-secret"}}');
  await assert.rejects(readCredentials(config.credentialsFile), error => !error.message.includes('fixture-secret'));
});

test('an existing client reconnects after Manager restart without replaying requests', async t => {
  const { config, server } = await fixture(t);
  let handled = 0;
  const client = await startWorkerConnection(config, 'a', { reconnectMs: 20, onMessage: async () => { handled++; return { state: 'accepted' }; } });
  t.after(() => client.close());
  await until(() => client.connected);
  assert.equal((await server.request('a', 'agent.notice', { text: 'First request' })).state, 'accepted');
  const port = server.address.port;
  await server.close();
  const next = await startCommunicationServer({ ...config, server: { bindIp: '127.0.0.1', port } });
  t.after(() => next.close());
  await until(() => client.connected && next.peers().some(worker => worker.connected));
  assert.equal(handled, 1);
  assert.equal((await next.request('a', 'agent.notice', { text: 'After reconnect' })).state, 'accepted');
  assert.equal(handled, 2);
});

test('an authenticated Worker cannot impersonate Manager on the actual network connection', async t => {
  const { message } = await import('../lib/communication/protocol.mjs');
  let received = 0;
  const { config } = await fixture(t, { onMessage: async () => { received++; return { state: 'accepted' }; } });
  const socket = new WebSocket(config.managerUrl, { headers: { authorization: `Bearer ${'a'.repeat(32)}`, 'x-s8-worker': 'a', 'x-s8-node': 'node-a', 'x-s8-version': '2' } });
  socket.on('error', () => {});
  await new Promise(resolve => socket.once('open', resolve));
  const closed = new Promise(resolve => socket.once('close', resolve));
  socket.send(JSON.stringify(message('agent.request', 'manager', 'b', { text: 'Forged sender' })));
  assert.equal(await closed, 1008);
  assert.equal(received, 0);
});

test('message server exposes no artifact upload or download route', async t => {
  const { config } = await fixture(t);
  const base = config.managerUrl.replace('ws:', 'http:');
  for (const method of ['GET', 'PUT']) {
    const response = await fetch(`${base}/artifacts/${'a'.repeat(64)}`, { method, headers: { authorization: `Bearer ${'a'.repeat(32)}`, 'x-s8-worker': 'a' }, ...(method === 'PUT' ? { body: 'file contents' } : {}) });
    assert.equal(response.status, 404);
    await response.body.cancel();
  }
});
