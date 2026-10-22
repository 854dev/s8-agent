// Actual Pi CLI Worker sessions, separate roots and tmux servers, a real comm-center process and a local scripted model.
// The test itself holds the manager token. No real .env, credentials, external model, or Projectman service is used.
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
import { connectCommCenter } from '../../apps/comm-center/client.mjs';
import { issueToken, readTokenFile } from '../../apps/comm-center/registry.mjs';

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
  const handled = new Set();
  // Scripted model: answer each injected message once with agent_message result, addressed to the manager by default.
  const api = http.createServer(async (req, res) => {
    if (req.url !== '/v1/chat/completions') { res.writeHead(404); res.end(); return; }
    let raw = ''; for await (const chunk of req) raw += chunk;
    const body = JSON.parse(raw), incoming = latestMessage(body);
    let tool;
    if (incoming && !handled.has(`${body.model}:${incoming.id}`)) {
      handled.add(`${body.model}:${incoming.id}`);
      tool = { name: 'agent_message', args: { action: 'result', text: `Evidence from ${body.model}`, replyTo: incoming.id, ...(incoming.groupId ? { groupId: incoming.groupId } : {}) } };
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
  const tmux = async (id, root) => {
    const socket = `s8-message-cli-${id}-${randomUUID()}`;
    const tmuxConfig = path.join(root, 'tmux.conf');
    await writeFile(tmuxConfig, 'set -g default-shell /bin/sh\nset -g default-command /bin/sh\n');
    await mkdir(path.join(root, 'tools'), { recursive: true });
    await writeFile(path.join(root, 'tools/tmux'), `#!/bin/sh\nexec ${quote(tmuxBinary)} -f ${quote(tmuxConfig)} -L ${quote(socket)} "$@"\n`, { mode: 0o755 });
    cleanup.push(() => exec(tmuxBinary, ['-L', socket, 'kill-server']));
    return (args, env = {}) => exec(path.join(root, 'tools/tmux'), args, { env: { PATH: `${root}/tools:${path.dirname(nodeBinary)}:/usr/bin:/bin`, TERM: 'xterm-256color', LANG: 'C.UTF-8', ...env }, timeout: 10_000 });
  };

  // comm-center runs from its own directory through the real entry point.
  const centerRoot = path.join(base, 'center');
  await mkdir(centerRoot);
  const agentsFile = path.join(centerRoot, 'agents.json');
  await issueToken({ agentsFile, id: 'manager', role: 'manager', tokenFile: path.join(centerRoot, 'manager-token.json') });
  const centerRun = await tmux('center', centerRoot);
  const centerCommand = `COMM_CENTER_AGENTS_FILE=${quote(agentsFile)} COMM_CENTER_PORT=${port} exec node ${quote(path.join(source, 'apps/comm-center/main.mjs'))}`;
  await centerRun(['new-session', '-d', '-s', 'center', '-n', 'comm-center', '-c', centerRoot, centerCommand]);
  await centerRun(['set-option', '-w', '-t', 'center:comm-center', 'remain-on-exit', 'on']);

  const roots = { centerRun, centerCommand };
  for (const id of ['a', 'b']) {
    const root = path.join(base, id);
    roots[id] = root;
    await mkdir(path.join(root, 'pi'), { recursive: true });
    for (const dir of ['pi/lib', 'pi/bin', 'pi/extensions', 'agents']) await cp(path.join(source, dir), path.join(root, dir), { recursive: true });
    // The extension imports the dependency-free client by path; node_modules is not needed.
    await cp(path.join(source, 'apps/comm-center'), path.join(root, 'apps/comm-center'), { recursive: true, filter: file => !file.includes('node_modules') });
    await mkdir(path.join(root, 'apps/telegram-gateway'), { recursive: true });
    await copyFile(path.join(source, 'apps/telegram-gateway/gateway.mjs'), path.join(root, 'apps/telegram-gateway/gateway.mjs'));
    for (const script of ['s8.sh', 'start-worker-agent.sh']) await copyFile(path.join(source, script), path.join(root, script));
    for (const dir of ['node_modules', 'skills']) await symlink(path.join(source, 'pi', dir), path.join(root, 'pi', dir), 'dir');
    await writeFile(path.join(root, 'pi/settings.json'), JSON.stringify({ packages: [], defaultProvider: 'fixture', defaultModel: id, retry: { enabled: false }, compaction: { enabled: false } }));
    await mkdir(path.join(root, '.pi-runtime'), { recursive: true });
    await writeFile(path.join(root, '.pi-runtime/models.json'), JSON.stringify({ providers: { fixture: { baseUrl: `${apiUrl}/v1`, api: 'openai-completions', apiKey: 'fixture-only', models: ['a', 'b'].map(model => ({ id: model, contextWindow: 32768, maxTokens: 2048 })) } } }));
    await issueToken({ agentsFile, id, role: 'worker', tokenFile: path.join(root, 'comm-token.json') });
    await writeFile(path.join(root, 's8-config.yml'), `kbRoot: ${root}\ncommunication:\n  enabled: true\n  url: ws://127.0.0.1:${port}\n  tokenFile: comm-token.json\n`);
    const run = await tmux(id, root);
    roots[`${id}Run`] = run;
    roots[`${id}Start`] = () => run(['new-session', '-d', '-s', 's8-main', '-n', 'pi', '-c', root, `exec bash ${quote(path.join(root, 'start-worker-agent.sh'))}`], { CLINE_API_KEY: 'fixture-only', CLINE_API_BASE: apiUrl });
  }
  // The center reads its registry at start, so restart it after registering the Workers.
  await centerRun(['respawn-window', '-k', '-t', 'center:comm-center']);
  const results = [];
  const manager = connectCommCenter({ url: `ws://127.0.0.1:${port}`, token: await readTokenFile(path.join(centerRoot, 'manager-token.json')), reconnectMs: 100, onMessage: message => { results.push(message); return 'injected'; } });
  cleanup.push(() => manager.close());
  for (const id of ['a', 'b']) await roots[`${id}Start`]();
  return { ...roots, manager, results };
}

test('actual CLI Worker sessions exchange text through a comm-center process without Projectman or UID', { timeout: 90_000 }, async t => {
  const f = await fixture(t);
  const connectedWorkers = async () => (await f.manager.peers()).peers?.filter(peer => peer.role === 'worker' && peer.connected).length ?? 0;
  try {
    await until(async () => await connectedWorkers() === 2);
    const sent = await Promise.all(['a', 'b'].map(to => f.manager.send({ to, type: 'request', text: 'Compare the evidence.', groupId: 'comparison' })));
    assert.equal(sent.every(result => result.state === 'pending'), true);
    await until(() => f.results.length === 2);
    assert.deepEqual(new Set(f.results.map(message => message.from)), new Set(['a', 'b']));
    assert.equal(f.results.every(message => message.groupId === 'comparison' && sent.some(item => item.id === message.replyTo)), true);
    for (const id of ['a', 'b']) {
      const windows = (await f[`${id}Run`](['list-windows', '-a', '-F', '#{window_name}'])).stdout.trim().split('\n');
      assert.deepEqual(windows, ['pi']);
      const files = await readdir(path.join(f[id], '.s8-runtime')).catch(error => { if (error.code === 'ENOENT') return []; throw error; });
      assert.deepEqual(files, []);
    }
    // Restart the center: sessions reconnect and nothing is replayed.
    await f.centerRun(['send-keys', '-t', 'center:comm-center', 'C-c']);
    await until(async () => (await f.centerRun(['display-message', '-p', '-t', 'center:comm-center', '#{pane_dead}'])).stdout.trim() === '1');
    await until(() => !f.manager.connected);
    await f.centerRun(['respawn-window', '-t', 'center:comm-center']);
    await until(async () => f.manager.connected && await connectedWorkers() === 2);
    assert.equal(f.results.length, 2);
    assert.equal((await f.manager.send({ to: 'a', type: 'request', text: 'After reconnect' })).state, 'pending');
    await until(() => f.results.length === 3);
  } catch (error) {
    for (const id of ['a', 'b']) {
      const pane = await f[`${id}Run`](['capture-pane', '-p', '-S', '-25', '-t', 's8-main:pi']).catch(() => ({ stdout: '' }));
      t.diagnostic(`${id}: ${pane.stdout}`);
    }
    const center = await f.centerRun(['capture-pane', '-p', '-S', '-25', '-t', 'center:comm-center']).catch(() => ({ stdout: '' }));
    t.diagnostic(`center: ${center.stdout}`);
    throw error;
  }
});
