import test from 'node:test';
import assert from 'node:assert/strict';
import { chmod, mkdtemp, readFile, rm, stat, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { WebSocket as WsClient } from 'ws';
import { startCommCenter } from './server.mjs';
import { connectCommCenter } from './client.mjs';
import { issueToken, readRegistry, readTokenFile } from './registry.mjs';
import { parseFrame } from './protocol.mjs';

const until = async check => { for (let i = 0; i < 200; i++) { if (await check()) return; await new Promise(resolve => setTimeout(resolve, 10)); } assert.fail('condition timeout'); };

async function fixture(t, options = {}) {
  const root = await mkdtemp(path.join(os.tmpdir(), 's8-comm-center-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const agentsFile = path.join(root, 'agents.json');
  const tokens = {};
  for (const [id, role] of [['manager', 'manager'], ['a', 'worker'], ['b', 'worker']]) {
    await issueToken({ agentsFile, id, role, tokenFile: path.join(root, `${id}.json`) });
    tokens[id] = await readTokenFile(path.join(root, `${id}.json`));
  }
  const events = [];
  const center = await startCommCenter({ agentsFile, port: 0, onEvent: event => events.push(event), ...options });
  t.after(() => center.close());
  const url = `ws://127.0.0.1:${center.address.port}`;
  const connect = async (id, handlers = {}) => {
    const client = connectCommCenter({ url, token: tokens[id], reconnectMs: 20, ...handlers });
    t.after(() => client.close());
    if (handlers.wait !== false) await until(() => client.connected);
    return client;
  };
  return { root, agentsFile, tokens, center, url, connect, events };
}

test('the center assigns identity from the token and routes Manager ↔ Worker text', async t => {
  const f = await fixture(t);
  const received = { manager: [], a: [] };
  const manager = await f.connect('manager', { onMessage: message => { received.manager.push(message); return 'injected'; } });
  const a = await f.connect('a', { onMessage: message => { received.a.push(message); return 'pending'; } });
  assert.deepEqual([manager.agentId, manager.role, a.agentId, a.role], ['manager', 'manager', 'a', 'worker']);

  const sent = await manager.send({ to: 'a', type: 'request', text: 'Please check the evidence.' });
  assert.equal(sent.state, 'pending');
  assert.equal(received.a[0].from, 'manager');
  assert.equal(received.a[0].text, 'Please check the evidence.');
  assert.equal((await manager.status(sent.id)).state, 'pending');
  a.ack(received.a[0], 'injected');
  await until(async () => (await manager.status(sent.id)).state === 'injected');

  const answer = await a.send({ to: 'manager', type: 'reply', text: 'The acceptance condition.', replyTo: sent.id });
  assert.equal(answer.state, 'injected');
  assert.equal(received.manager[0].from, 'a');
  assert.equal(received.manager[0].replyTo, sent.id);
  assert.equal(JSON.stringify(f.events).includes('evidence'), false, 'logs carry metadata, not conversations');
});

test('Workers cannot address each other, list peers or send unknown recipients', async t => {
  const f = await fixture(t);
  const manager = await f.connect('manager');
  const a = await f.connect('a');
  let bReceived = 0;
  await f.connect('b', { onMessage: () => { bReceived++; return 'injected'; } });
  assert.equal((await a.send({ to: 'b', type: 'notice', text: 'Bypass the manager' })).state, 'rejected');
  assert.equal(bReceived, 0);
  assert.equal((await a.peers()).state, 'rejected');
  assert.equal((await manager.send({ to: 'missing', type: 'notice', text: 'Hello' })).state, 'unavailable');
  assert.equal((await manager.send({ to: 'manager', type: 'notice', text: 'Self' })).state, 'rejected');
  const listed = await manager.peers();
  assert.equal(listed.state, 'accepted');
  assert.deepEqual(listed.peers.map(peer => [peer.id, peer.role, peer.connected]), [['manager', 'manager', true], ['a', 'worker', true], ['b', 'worker', true]]);
});

test('fan-out uses one send per recipient with a shared groupId', async t => {
  const f = await fixture(t);
  const manager = await f.connect('manager');
  const seen = [];
  await f.connect('a', { onMessage: message => { seen.push(message); return 'pending'; } });
  await f.connect('b', { onMessage: message => { seen.push(message); return 'pending'; } });
  const results = await Promise.all(['a', 'b'].map(to => manager.send({ to, type: 'request', text: 'Compare the evidence.', groupId: 'group-1' })));
  assert.equal(results.every(result => result.state === 'pending'), true);
  assert.notEqual(results[0].id, results[1].id);
  assert.deepEqual(seen.map(message => message.groupId), ['group-1', 'group-1']);
});

test('a retried send is not delivered twice and a reused ID with new content is rejected', async t => {
  const f = await fixture(t);
  const manager = await f.connect('manager');
  let calls = 0;
  await f.connect('a', { onMessage: () => { calls++; return 'pending'; } });
  const first = await manager.send({ id: 'fixed-id', to: 'a', type: 'notice', text: 'Once' });
  const again = await manager.send({ id: 'fixed-id', to: 'a', type: 'notice', text: 'Once' });
  assert.deepEqual([first.state, again.state, calls], ['pending', 'pending', 1]);
  assert.equal((await manager.send({ id: 'fixed-id', to: 'a', type: 'notice', text: 'Different' })).state, 'rejected');
});

test('an unacknowledged or disconnected recipient yields unknown and nothing is replayed', async t => {
  const f = await fixture(t, { timeoutMs: 50 });
  const manager = await f.connect('manager');
  let calls = 0;
  const silent = await f.connect('a', { onMessage: () => { calls++; return new Promise(() => {}); } });
  assert.equal((await manager.send({ to: 'a', type: 'request', text: 'Research' })).state, 'unknown');
  const lost = manager.send({ to: 'a', type: 'request', text: 'Research more' });
  await until(() => calls === 2);
  await silent.close();
  assert.equal((await lost).state, 'unknown');
  const next = await f.connect('a', { onMessage: () => { calls++; return 'pending'; } });
  assert.equal(next.connected, true);
  assert.equal(calls, 2);
});

test('clients reconnect after a center restart without replaying requests', async t => {
  const f = await fixture(t);
  let handled = 0;
  const a = await f.connect('a', { onMessage: () => { handled++; return 'pending'; } });
  const manager = await f.connect('manager');
  assert.equal((await manager.send({ to: 'a', type: 'notice', text: 'First' })).state, 'pending');
  const port = f.center.address.port;
  await f.center.close();
  await until(() => !a.connected && !manager.connected);
  const next = await startCommCenter({ agentsFile: f.agentsFile, port });
  t.after(() => next.close());
  await until(() => a.connected && manager.connected);
  assert.equal(handled, 1);
  assert.equal((await manager.send({ to: 'a', type: 'notice', text: 'After restart' })).state, 'pending');
  assert.equal(handled, 2);
});

test('bad tokens, wrong versions, browsers and duplicate identities are refused', async t => {
  const f = await fixture(t);
  const bad = connectCommCenter({ url: f.url, token: 'x'.repeat(43) });
  t.after(() => bad.close());
  await until(() => bad.lastError === 'UNAUTHORIZED');

  const closeCode = hello => new Promise(resolve => {
    const ws = new WsClient(f.url);
    ws.on('error', () => {});
    ws.on('open', () => ws.send(JSON.stringify(hello)));
    ws.on('close', code => resolve(code));
  });
  assert.equal(await closeCode({ kind: 'hello', version: 99, token: f.tokens.a }), 4000);
  assert.equal(await closeCode({ kind: 'send', id: 'x', to: 'manager', type: 'notice', text: 'Before hello' }), 4001);

  const browser = await new Promise(resolve => {
    const ws = new WsClient(f.url, { headers: { origin: 'http://browser.invalid' } });
    ws.on('error', () => {});
    ws.on('unexpected-response', (_req, response) => { resolve(response.statusCode); response.destroy(); ws.terminate(); });
  });
  assert.equal(browser, 403);

  await f.connect('a');
  const duplicate = connectCommCenter({ url: f.url, token: f.tokens.a, reconnectMs: 10_000 });
  t.after(() => duplicate.close());
  await until(() => duplicate.lastError === 'DUPLICATE_AGENT');
});

test('an authenticated agent cannot forge its sender or acknowledge others’ messages', async t => {
  const f = await fixture(t);
  const received = [];
  await f.connect('manager', { onMessage: message => { received.push(message); return 'injected'; } });
  const ws = new WsClient(f.url);
  ws.on('error', () => {});
  await new Promise(resolve => ws.once('open', resolve));
  const frames = [];
  ws.on('message', data => frames.push(JSON.parse(data.toString())));
  ws.send(JSON.stringify({ kind: 'hello', version: 1, token: f.tokens.a }));
  await until(() => frames.some(frame => frame.kind === 'welcome'));
  // Extra fields such as `from` are rejected outright.
  const closed = new Promise(resolve => ws.once('close', resolve));
  ws.send(JSON.stringify({ kind: 'send', id: 'forged', from: 'b', to: 'manager', type: 'notice', text: 'Forged sender' }));
  assert.equal(await closed, 1008);
  assert.equal(received.length, 0);
});

test('only the recipient can acknowledge a message', async t => {
  const f = await fixture(t);
  const manager = await f.connect('manager');
  let message;
  await f.connect('a', { onMessage: input => { message = input; return 'pending'; } });
  const b = await f.connect('b');
  const sent = await manager.send({ to: 'a', type: 'request', text: 'Only for A' });
  b.ack(message, 'injected');
  await new Promise(resolve => setTimeout(resolve, 30));
  assert.equal((await manager.status(sent.id)).state, 'pending');
});

test('a Worker may omit the recipient and reaches the single registered manager', async t => {
  const f = await fixture(t);
  const received = [];
  await f.connect('manager', { onMessage: message => { received.push(message); return 'pending'; } });
  const a = await f.connect('a');
  const sent = await a.send({ type: 'notice', text: 'Started the task.' });
  assert.deepEqual([sent.to, sent.state, received[0].from], ['manager', 'pending', 'a']);
});

test('a manager must name its recipient', async t => {
  const f = await fixture(t);
  const manager = await f.connect('manager');
  assert.equal((await manager.send({ type: 'notice', text: 'To whom?' })).state, 'rejected');
});

test('a silent center is detected and the client reconnects', async t => {
  const f = await fixture(t, { heartbeatMs: 60_000 });
  const states = [];
  const a = await f.connect('a', { idleMs: 80, onState: (connected, error) => states.push(connected ? 'up' : error) });
  await until(() => states.includes('TIMEOUT'));
  await until(() => a.connected);
});

test('the center pings often enough to keep idle clients connected', async t => {
  const f = await fixture(t, { heartbeatMs: 20 });
  const states = [];
  const a = await f.connect('a', { idleMs: 80, onState: (connected, error) => states.push(connected ? 'up' : error) });
  await new Promise(resolve => setTimeout(resolve, 250));
  assert.deepEqual(states, ['up']);
  assert.equal(a.connected, true);
});

test('concurrent registrations are refused instead of losing entries', async t => {
  const f = await fixture(t);
  await writeFile(`${f.agentsFile}.lock`, 'held');
  await assert.rejects(issueToken({ agentsFile: f.agentsFile, id: 'c', role: 'worker', tokenFile: path.join(f.root, 'c.json') }), /another registration/);
  await rm(`${f.agentsFile}.lock`);
  await issueToken({ agentsFile: f.agentsFile, id: 'c', role: 'worker', tokenFile: path.join(f.root, 'c.json') });
  assert.deepEqual([...(await readRegistry(f.agentsFile)).keys()], ['manager', 'a', 'b', 'c']);
});

test('the HTTP side exposes no routes', async t => {
  const f = await fixture(t);
  for (const route of ['/', '/peers', '/messages']) {
    const response = await fetch(f.url.replace('ws:', 'http:') + route);
    assert.equal(response.status, 404);
    await response.body?.cancel();
  }
});

test('frames are validated without echoing contents', () => {
  for (const frame of [
    { kind: 'send', id: 'a', to: 'manager', type: 'command', text: 'fixture-secret' },
    { kind: 'send', id: 'a', to: 'manager', type: 'reply', text: 'fixture-secret' },
    { kind: 'send', id: 'a', to: 'manager', type: 'notice', text: ' ' },
    { kind: 'send', id: 'a', to: 'manager', type: 'notice', text: 'x'.repeat(16_001) },
    { kind: 'send', id: '../x', to: 'manager', type: 'notice', text: 'fixture-secret' },
    { kind: 'run', command: 'fixture-secret' },
    { kind: 'ack', for: 'a', from: 'manager', state: 'done' },
  ]) assert.throws(() => parseFrame(frame), error => !error.message.includes('fixture-secret'));
});

test('registry and token files must be private and store only hashes', async t => {
  const f = await fixture(t);
  const registry = await readFile(f.agentsFile, 'utf8');
  for (const token of Object.values(f.tokens)) assert.equal(registry.includes(token), false);
  assert.equal((await stat(f.agentsFile)).mode & 0o777, 0o600);
  assert.equal((await stat(path.join(f.root, 'a.json'))).mode & 0o777, 0o600);
  await assert.rejects(issueToken({ agentsFile: f.agentsFile, id: 'c', role: 'worker', tokenFile: path.join(f.root, 'a.json') }), { code: 'EEXIST' });
  await chmod(f.agentsFile, 0o644);
  await assert.rejects(readRegistry(f.agentsFile), /private regular/);
  await writeFile(path.join(f.root, 'leak.json'), '{"agents":{"a":{"role":"worker","tokenSha256":"fixture-secret"}}}', { mode: 0o600 });
  await assert.rejects(readRegistry(path.join(f.root, 'leak.json')), error => !error.message.includes('fixture-secret'));
});
