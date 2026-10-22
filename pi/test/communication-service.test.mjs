import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, writeFile, rm, readdir } from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { registerCommunication } from '../extensions/communication.mjs';
import { startCommCenter } from '../../apps/comm-center/server.mjs';
import { issueToken } from '../../apps/comm-center/registry.mjs';

const until = async check => { for (let i = 0; i < 300; i++) { if (await check()) return; await new Promise(resolve => setTimeout(resolve, 10)); } assert.fail('condition timeout'); };

// One comm-center and a separate checkout root per agent, as on different machines.
async function fixture(t) {
  const base = await mkdtemp(path.join(os.tmpdir(), 's8-comm-'));
  t.after(() => rm(base, { recursive: true, force: true }));
  const agentsFile = path.join(base, 'agents.json');
  const roots = {};
  for (const [id, role] of [['manager', 'manager'], ['a', 'worker'], ['b', 'worker']]) {
    roots[id] = await mkdtemp(path.join(base, `${id}-`));
    await issueToken({ agentsFile, id, role, tokenFile: path.join(roots[id], 'token.json') });
  }
  const center = await startCommCenter({ agentsFile, port: 0 });
  t.after(() => center.close());
  for (const root of Object.values(roots)) {
    await writeFile(path.join(root, 's8-config.yml'), `communication:\n  enabled: true\n  url: ws://127.0.0.1:${center.address.port}\n  tokenFile: token.json\n`);
  }
  return { roots, center };
}

async function session(t, root) {
  const tools = new Map(), handlers = new Map(), entries = [], notices = [];
  let idle = true;
  const ctx = { hasUI: true, ui: { notify: (text, level) => notices.push({ text, level }) }, isIdle: () => idle, sessionManager: { getBranch: () => entries } };
  registerCommunication({
    on: (name, handler) => handlers.set(name, handler), registerTool: tool => tools.set(tool.name, tool),
    sendMessage: value => entries.push({ type: 'custom_message', ...value }),
  }, { root });
  await handlers.get('session_start')({}, ctx);
  t.after(() => handlers.get('session_shutdown')());
  const send = args => tools.get('agent_message').execute('call', args, undefined, undefined, ctx).then(result => JSON.parse(result.content[0].text));
  return { entries, notices, send, setIdle: value => { idle = value; } };
}

const connected = (center, ids) => until(() => ids.every(id => center.peers().find(peer => peer.id === id)?.connected));

test('sessions on separate roots exchange text through comm-center without a task or Projectman', async t => {
  const f = await fixture(t);
  const manager = await session(t, f.roots.manager);
  const worker = await session(t, f.roots.a);
  await connected(f.center, ['manager', 'a']);
  const listed = await manager.send({ action: 'list' });
  assert.deepEqual(listed.peers.map(peer => [peer.id, peer.connected]), [['manager', true], ['a', true], ['b', false]]);

  worker.setIdle(false);
  const sent = await manager.send({ action: 'request', to: ['a'], text: 'Which evidence applies?' });
  assert.equal(sent.results[0].state, 'pending');
  assert.equal(worker.entries.length, 0);
  worker.setIdle(true);
  await until(() => worker.entries.length === 1);
  await until(async () => (await manager.send({ action: 'status', messageId: sent.results[0].id })).state === 'injected');

  // Workers reach the manager without knowing its ID.
  const incoming = worker.entries[0].details.communication;
  assert.equal(incoming.from, 'manager');
  const replied = await worker.send({ action: 'reply', text: 'The documented acceptance condition.', replyTo: incoming.id });
  assert.equal(replied.results[0].to, 'manager');
  await until(() => manager.entries.length === 1);
  assert.equal(manager.entries[0].details.communication.from, 'a');
  assert.equal(manager.entries[0].details.communication.replyTo, incoming.id);

  const offline = await manager.send({ action: 'request', to: ['b'], text: 'Hello' });
  assert.equal(offline.results[0].state, 'unavailable');
  assert.deepEqual(await readdir(path.join(f.roots.a, '.s8-runtime')).catch(error => { if (error.code === 'ENOENT') return []; throw error; }), []);
});

test('fan-out shares a groupId while comm-center enforces Worker routing', async t => {
  const f = await fixture(t);
  const manager = await session(t, f.roots.manager);
  const a = await session(t, f.roots.a);
  const b = await session(t, f.roots.b);
  await connected(f.center, ['manager', 'a', 'b']);
  const result = await manager.send({ action: 'request', to: ['a', 'b'], text: 'Compare the evidence.' });
  assert.equal(result.results.every(item => item.state === 'pending'), true);
  assert.notEqual(result.results[0].id, result.results[1].id);
  await until(() => a.entries.length === 1 && b.entries.length === 1);
  assert.equal(a.entries[0].details.communication.groupId, result.groupId);
  assert.equal(b.entries[0].details.communication.groupId, result.groupId);
  assert.equal((await a.send({ action: 'list' })).state, 'rejected');
  assert.equal((await a.send({ action: 'notice', to: ['b'], text: 'Bypass' })).results[0].state, 'rejected');
  assert.equal(b.entries.length, 1);
});

test('a missing token file disables messaging with a notice instead of failing the session', async t => {
  const f = await fixture(t);
  await rm(path.join(f.roots.a, 'token.json'));
  const worker = await session(t, f.roots.a);
  assert.match(worker.notices[0].text, /token file/);
  await assert.rejects(worker.send({ action: 'notice', text: 'Hello' }), /disabled or its token file/);
});

test('a second session with the same token is told it is a duplicate', async t => {
  const f = await fixture(t);
  await session(t, f.roots.a);
  await connected(f.center, ['a']);
  const second = await session(t, f.roots.a);
  await until(() => second.notices.some(notice => /already connected/.test(notice.text)));
  const sent = await second.send({ action: 'notice', text: 'Hello' });
  assert.deepEqual([sent.results[0].state, sent.results[0].connection], ['unavailable', 'DUPLICATE_AGENT']);
});
