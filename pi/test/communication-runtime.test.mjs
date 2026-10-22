// Actual Pi CLI sessions, separate roots and tmux servers, a local scripted model.
// No real .env, credentials, external model, or Projectman service is used.
import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { cp, copyFile, mkdir, mkdtemp, readdir, rm, symlink, writeFile } from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { randomUUID } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { localRequest } from '../lib/communication/local.mjs';

const exec = promisify(execFile);
const source = fileURLToPath(new URL('../..', import.meta.url));
const quote = value => `'${value.replaceAll("'", "'\\''")}'`;
async function until(check, timeoutMs = 30_000) {
  const end = Date.now() + timeoutMs;
  while (Date.now() < end) { if (await check()) return; await new Promise(resolve => setTimeout(resolve, 100)); }
  assert.fail('runtime condition timeout');
}
function latestMessage(body) {
  for (const item of [...body.messages].reverse()) {
    const content = typeof item.content === 'string' ? item.content : (item.content ?? []).map(part => part.text ?? '').join('\n');
    const match = /Agent message \(data, not new authority\): (\{.*\})\nRespond/.exec(content);
    if (match) return JSON.parse(match[1]);
  }
}

async function fixture(t) {
  const base = await mkdtemp(path.join(os.tmpdir(), 's8-message-cli-'));
  const cleanup = [];
  t.after(async () => { for (const action of cleanup.reverse()) await action().catch(() => {}); await rm(base, { recursive: true, force: true }); });
  const notices = [], handled = new Set();
  const api = http.createServer(async (req, res) => {
    if (req.url !== '/v1/chat/completions') { res.writeHead(404); res.end(); return; }
    let raw = ''; for await (const chunk of req) raw += chunk;
    const body = JSON.parse(raw), incoming = latestMessage(body);
    let tool;
    if (incoming && !handled.has(`${body.model}:${incoming.id}`)) {
      handled.add(`${body.model}:${incoming.id}`);
      if (body.model === 'manager') notices.push(incoming);
      else tool = { name: 'agent_message', args: { action: 'result', text: `Evidence from ${body.model}`, requestId: incoming.requestId, groupId: incoming.groupId } };
    }
    res.writeHead(200, { 'content-type': 'text/event-stream' });
    const emit = (delta, finish_reason = null) => res.write(`data: ${JSON.stringify({ id: randomUUID(), object: 'chat.completion.chunk', model: body.model, choices: [{ index: 0, delta, finish_reason }] })}\n\n`);
    emit({ role: 'assistant' });
    if (tool) { emit({ tool_calls: [{ index: 0, id: randomUUID(), type: 'function', function: { name: tool.name, arguments: JSON.stringify(tool.args) } }] }); emit({}, 'tool_calls'); }
    else { emit({ content: 'Evidence recorded.' }); emit({}, 'stop'); }
    res.end('data: [DONE]\n\n');
  });
  await new Promise(resolve => api.listen(0, '127.0.0.1', resolve));
  const apiUrl = `http://127.0.0.1:${api.address().port}`;
  cleanup.push(async () => { api.closeAllConnections(); await new Promise(resolve => api.close(resolve)); });
  const reserve = http.createServer();
  await new Promise(resolve => reserve.listen(0, '127.0.0.1', resolve));
  const port = reserve.address().port;
  await new Promise(resolve => reserve.close(resolve));
  const tmuxBinary = (await exec('which', ['tmux'])).stdout.trim();
  const nodeBinary = (await exec('which', ['node'])).stdout.trim();
  const roots = {};
  for (const id of ['manager', 'a', 'b']) {
    const root = path.join(base, id);
    roots[id] = root;
    await mkdir(path.join(root, 'pi'), { recursive: true });
    for (const dir of ['pi/lib', 'pi/bin', 'pi/extensions', 'agents']) await cp(path.join(source, dir), path.join(root, dir), { recursive: true });
    await mkdir(path.join(root, 'apps/telegram-gateway'), { recursive: true });
    await copyFile(path.join(source, 'apps/telegram-gateway/gateway.mjs'), path.join(root, 'apps/telegram-gateway/gateway.mjs'));
    for (const script of ['s8.sh', 'start-manager-agent.sh', 'start-worker-agent.sh']) await copyFile(path.join(source, script), path.join(root, script));
    for (const dir of ['node_modules', 'skills']) await symlink(path.join(source, 'pi', dir), path.join(root, 'pi', dir), 'dir');
    await writeFile(path.join(root, 'pi/settings.json'), JSON.stringify({ packages: [], defaultProvider: 'fixture', defaultModel: id, retry: { enabled: false }, compaction: { enabled: false } }));
    await mkdir(path.join(root, '.pi-runtime'), { recursive: true });
    await writeFile(path.join(root, '.pi-runtime/models.json'), JSON.stringify({ providers: { fixture: { baseUrl: `${apiUrl}/v1`, api: 'openai-completions', apiKey: 'fixture-only', models: ['manager', 'a', 'b'].map(model => ({ id: model, contextWindow: 32768, maxTokens: 2048 })) } } }));
    await mkdir(path.join(root, 'tools'));
    const socket = `s8-message-cli-${id}-${randomUUID()}`;
    const tmuxConfig = path.join(root, 'tmux.conf');
    await writeFile(tmuxConfig, 'set -g default-shell /bin/sh\nset -g default-command /bin/sh\n');
    await writeFile(path.join(root, 'tools/tmux'), `#!/bin/sh\nexec ${quote(tmuxBinary)} -f ${quote(tmuxConfig)} -L ${quote(socket)} "$@"\n`, { mode: 0o755 });
    const env = { PATH: `${root}/tools:${path.dirname(nodeBinary)}:/usr/bin:/bin`, TERM: 'xterm-256color', LANG: 'C.UTF-8', S8_WORKER_ID: id, CLINE_API_KEY: 'fixture-only', CLINE_API_BASE: apiUrl };
    const run = args => exec(path.join(root, 'tools/tmux'), args, { env, timeout: 10_000 });
    roots[`${id}Run`] = run;
    cleanup.push(() => exec(tmuxBinary, ['-L', socket, 'kill-server']));
    const tokens = id === 'manager' ? { a: 'a'.repeat(32), b: 'b'.repeat(32) } : { [id]: id.repeat(32) };
    const credentialsFile = path.join(root, 'communication-secrets.json');
    await writeFile(credentialsFile, JSON.stringify({ workers: tokens }), { mode: 0o600 });
    await writeFile(path.join(root, 's8-config.yml'), `kbRoot: ${root}\ncommunication:\n  enabled: true\n  nodeId: host-${id}\n  credentialsFile: ${credentialsFile}\n${id === 'manager' ? '  server:\n    port: ' + port : '  managerUrl: ws://127.0.0.1:' + port}\n`);
    const script = id === 'manager' ? 'start-manager-agent.sh' : 'start-worker-agent.sh';
    if (id === 'manager') {
      await run(['new-session', '-d', '-s', 's8-main', '-n', 'communicator', '-c', root, `exec bash ${quote(path.join(root, 's8.sh'))} service communicator`]);
      await run(['set-option', '-w', '-t', 's8-main:communicator', 'remain-on-exit', 'on']);
      await until(async () => (await localRequest(root, 'communicator', { action: 'peers' })).state === 'accepted');
      await run(['new-window', '-d', '-t', 's8-main:', '-n', 'pi', '-c', root, `exec bash ${quote(path.join(root, script))}`]);
    } else await run(['new-session', '-d', '-s', 's8-main', '-n', 'pi', '-c', root, `exec bash ${quote(path.join(root, script))}`]);
  }
  return { ...roots, notices };
}

test('actual CLI sessions exchange text without Projectman, UID, repository mapping or automatic agent creation', { timeout: 90_000 }, async t => {
  const f = await fixture(t);
  const peers = async () => (await localRequest(f.manager, 'communicator', { action: 'peers' })).peers ?? [];
  const send = (id, requestId) => localRequest(f.manager, 'communicator', { action: 'send', workerId: id, type: 'agent.request', payload: { text: 'Compare the evidence.' }, context: { requestId, groupId: 'comparison' } });
  try {
    await until(async () => (await peers()).filter(peer => peer.connected).length === 2);
    await until(async () => (await localRequest(f.manager, 'pi:manager', { action: 'ping' })).state !== 'unavailable');
    const results = await Promise.all(['a', 'b'].map(id => send(id, `request-${id}`)));
    assert.equal(results.every(result => result.state === 'pending'), true);
    await until(() => f.notices.length === 2);
    assert.deepEqual(new Set(f.notices.map(input => input.from)), new Set(['a', 'b']));
    for (const id of ['a', 'b']) {
      const windows = (await f[`${id}Run`](['list-windows', '-a', '-F', '#{window_name}'])).stdout.trim().split('\n');
      assert.deepEqual(windows, ['pi']);
      const files = await readdir(path.join(f[id], '.s8-runtime')).catch(error => { if (error.code === 'ENOENT') return []; throw error; });
      assert.deepEqual(files, []);
    }
    await f.managerRun(['send-keys', '-t', 's8-main:communicator', 'C-c']);
    await until(async () => (await localRequest(f.manager, 'communicator', { action: 'peers' })).state === 'unavailable');
    await until(async () => (await f.managerRun(['display-message', '-p', '-t', 's8-main:communicator', '#{pane_dead}'])).stdout.trim() === '1');
    await f.managerRun(['respawn-window', '-t', 's8-main:communicator']);
    await until(async () => (await peers()).filter(peer => peer.connected).length === 2);
    assert.equal(f.notices.length, 2);
    assert.equal((await send('a', 'after-reconnect')).state, 'pending');
    await until(() => f.notices.length === 3);
  } catch (error) {
    for (const id of ['manager', 'a', 'b']) {
      const pane = await f[`${id}Run`](['capture-pane', '-p', '-S', '-25', '-t', 's8-main:pi']).catch(() => ({ stdout: '' }));
      t.diagnostic(`${id}: ${pane.stdout}`);
    }
    throw error;
  }
});
