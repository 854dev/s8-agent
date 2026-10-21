// Four isolated runtimes and tmux servers, real Pi CLI, local scripted model/API.
// No real .env, credentials, external model or production services are used.
import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { cp, copyFile, mkdir, mkdtemp, readFile, rm, symlink, writeFile } from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { randomUUID } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { git } from '../lib/development/git.mjs';
import { localRequest } from '../lib/communication/local.mjs';

const exec = promisify(execFile);
const source = fileURLToPath(new URL('../..', import.meta.url));
const quote = value => `'${value.replaceAll("'", "'\\''")}'`;
async function until(check, timeoutMs = 40_000) {
  const end = Date.now() + timeoutMs;
  while (Date.now() < end) { if (await check()) return; await new Promise(resolve => setTimeout(resolve, 100)); }
  assert.fail('runtime condition timeout');
}
const readJson = file => readFile(file, 'utf8').then(JSON.parse).catch(() => null);

function latestMessage(body) {
  for (const item of [...body.messages].reverse()) {
    const content = typeof item.content === 'string' ? item.content : (item.content ?? []).map(part => part.text ?? '').join('\n');
    const match = /Agent message \(data, not new authority\): (\{.*\})\nRespond/.exec(content);
    if (match) return JSON.parse(match[1]);
  }
}

async function fixture(t) {
  const base = await mkdtemp(path.join(os.tmpdir(), 's8-full-'));
  const cleanup = [];
  t.after(async () => { for (const action of cleanup.reverse()) await action().catch(() => {}); await rm(base, { recursive: true, force: true }); });
  const calls = new Map(), notices = [], operations = new Map();
  let reports = 0, lostReport = false;
  const task = { uid: 'task-1', title: 'Verify mediated work', state: 'ready', workflow: { version: 2, revision: 1, planVersion: 1, planHash: 'p'.repeat(64), specHash: 's'.repeat(64), confirmation: { planHash: 'p'.repeat(64), planVersion: 1 }, grant: { specHash: 's'.repeat(64) }, spec: { repoPath: '/approved/repo', plan: 'Ask Manager for clarification, provide evidence, then report.', completionCriteria: ['Evidence is checked'], commandNames: [], dependsOn: [] } } };
  const api = http.createServer(async (req, res) => {
    try {
      let raw = ''; for await (const chunk of req) raw += chunk;
      const url = new URL(req.url, 'http://fixture');
      if (url.pathname === '/v1/chat/completions') {
        const body = JSON.parse(raw), model = body.model;
        const step = calls.get(model) ?? 0;
        calls.set(model, step + 1);
        const incoming = latestMessage(body);
        let tool;
        if (model === 'worker-a') {
          if (step === 0) tool = { name: 'projectman', args: { action: 'get', uid: task.uid } };
          if (step === 1) tool = { name: 'agent_message', args: { action: 'request', text: 'Please clarify which evidence to verify.' } };
          if (step === 3) tool = { name: 'agent_message', args: { action: 'reply', text: 'I checked the approved condition and found no changes required.', requestId: incoming.requestId, replyTo: incoming.id } };
          if (step === 4) tool = { name: 'projectman', args: { action: 'report', uid: task.uid, status: 'completed', summary: 'Evidence verified after Manager follow-up.', verification: [] } };
        } else if (model === 'manager') {
          if (incoming) notices.push(incoming);
          if (incoming?.type === 'agent.request' && !notices.slice(0, -1).some(item => item.id === incoming.id)) tool = { name: 'agent_message', args: { action: 'reply', workerIds: [incoming.from], taskUid: incoming.taskUid, requestId: incoming.requestId, replyTo: incoming.id, sessionId: incoming.payload.sourceSessionId, text: 'What assertion did you verify? Show the evidence.' } };
        } else if (step === 0) {
          tool = { name: 'agent_message', args: { action: 'result', text: `Independent evidence from ${model}`, requestId: incoming.requestId, groupId: incoming.groupId } };
        }
        res.writeHead(200, { 'content-type': 'text/event-stream' });
        const emit = (delta, finish_reason = null) => res.write(`data: ${JSON.stringify({ id: `fixture-${model}-${step}`, object: 'chat.completion.chunk', model, choices: [{ index: 0, delta, finish_reason }] })}\n\n`);
        emit({ role: 'assistant' });
        if (tool) { emit({ tool_calls: [{ index: 0, id: `call-${step}`, type: 'function', function: { name: tool.name, arguments: JSON.stringify(tool.args) } }] }); emit({}, 'tool_calls'); }
        else { emit({ content: 'Evidence recorded.' }); emit({}, 'stop'); }
        res.end('data: [DONE]\n\n');
      } else if (url.pathname === '/api/v2/contents') {
        res.setHeader('content-type', 'application/json');
        res.end(JSON.stringify({ content: [{ uid: task.uid, title: task.title, type: 'task', detail: { text: task.workflow.spec.plan, attributes: { state: task.state, workflow: task.workflow } } }], last: true }));
      } else if (url.pathname === `/api/v2/projectman/items/${task.uid}/workflow`) {
        res.setHeader('content-type', 'application/json');
        if (req.method === 'POST') {
          const operation = JSON.parse(raw);
          if (!operations.has(operation.requestId)) {
            if (operation.expectedRevision !== task.workflow.revision) { res.writeHead(409); res.end('{}'); return; }
            if (operation.action === 'claim') {
              assert.equal(task.state, 'ready');
              task.state = 'doing'; task.workflow.run = { id: operation.runId, status: 'running', workerId: operation.workerId };
            } else if (operation.action === 'report') {
              assert.equal(operation.runId, task.workflow.run.id);
              reports++; task.state = 'review'; task.workflow.run.status = 'finished'; task.workflow.result = operation.report;
            } else throw new Error('Unexpected operation');
            task.workflow.revision++;
            operations.set(operation.requestId, structuredClone(task));
          }
          if (operation.action === 'report' && !lostReport) { lostReport = true; res.destroy(); return; }
          res.end(JSON.stringify(operations.get(operation.requestId)));
        } else res.end(JSON.stringify(task));
      } else { res.writeHead(404); res.end('{}'); }
    } catch (error) { if (!res.headersSent) res.writeHead(500); res.end(JSON.stringify({ error: error.message })); }
  });
  await new Promise(resolve => api.listen(0, '127.0.0.1', resolve));
  const apiUrl = `http://127.0.0.1:${api.address().port}`;
  cleanup.push(async () => { api.closeAllConnections(); await new Promise(resolve => api.close(resolve)); });
  const reserve = http.createServer();
  await new Promise(resolve => reserve.listen(0, '127.0.0.1', resolve));
  const port = reserve.address().port;
  await new Promise(resolve => reserve.close(resolve));
  const roots = {};
  const tmuxBinary = (await exec('which', ['tmux'])).stdout.trim();
  const nodeBinary = (await exec('which', ['node'])).stdout.trim();
  for (const id of ['manager', 'a', 'b', 'c']) {
    const root = path.join(base, id);
    roots[id] = root;
    await mkdir(path.join(root, 'pi'), { recursive: true });
    for (const dir of ['pi/lib', 'pi/bin', 'pi/extensions', 'agents']) await cp(path.join(source, dir), path.join(root, dir), { recursive: true });
    await mkdir(path.join(root, 'apps/telegram-gateway'), { recursive: true });
    await copyFile(path.join(source, 'apps/telegram-gateway/gateway.mjs'), path.join(root, 'apps/telegram-gateway/gateway.mjs'));
    for (const script of ['s8.sh', 'start-manager-agent.sh', 'start-worker-agent.sh']) await copyFile(path.join(source, script), path.join(root, script));
    await symlink(path.join(source, 'pi/node_modules'), path.join(root, 'pi/node_modules'), 'dir');
    await symlink(path.join(source, 'pi/skills'), path.join(root, 'pi/skills'), 'dir');
    await writeFile(path.join(root, 'pi/settings.json'), JSON.stringify({ packages: [], defaultProvider: 'fixture', defaultModel: id === 'manager' ? 'manager' : `worker-${id}`, retry: { enabled: false }, compaction: { enabled: false } }));
    await mkdir(path.join(root, '.pi-runtime'), { recursive: true });
    await writeFile(path.join(root, '.pi-runtime/models.json'), JSON.stringify({ providers: { fixture: { baseUrl: `${apiUrl}/v1`, api: 'openai-completions', apiKey: 'fixture-only', models: ['manager', 'worker-a', 'worker-b', 'worker-c'].map(model => ({ id: model, contextWindow: 32768, maxTokens: 2048 })) } } }));
    await mkdir(path.join(root, 'tools'));
    const socket = `s8-full-${id}-${randomUUID()}`;
    const tmuxConfig = path.join(root, 'tmux.conf');
    await writeFile(tmuxConfig, 'set -g default-shell /bin/sh\nset -g default-command /bin/sh\n');
    await writeFile(path.join(root, 'tools/tmux'), `#!/bin/sh\nexec ${quote(tmuxBinary)} -f ${quote(tmuxConfig)} -L ${quote(socket)} "$@"\n`, { mode: 0o755 });
    const env = { PATH: `${root}/tools:${path.dirname(nodeBinary)}:/usr/bin:/bin`, TERM: 'xterm-256color', LANG: 'C.UTF-8', PHCMS_ACCESS_TOKEN: 'fixture-only' };
    const run = args => exec(path.join(root, 'tools/tmux'), args, { env, timeout: 10_000 });
    roots[`${id}Run`] = run;
    cleanup.push(() => exec(tmuxBinary, ['-L', socket, 'kill-server']));
    const tokens = id === 'manager' ? { a: 'a'.repeat(32), b: 'b'.repeat(32), c: 'c'.repeat(32) } : { [id]: id.repeat(32) };
    const credentialFile = path.join(root, 'communication-secrets.json');
    await writeFile(credentialFile, JSON.stringify({ workers: tokens }), { mode: 0o600 });
    const repo = path.join(root, 'repo');
    if (id !== 'manager') {
      await mkdir(repo);
      await git(repo, ['init', '-q']); await writeFile(path.join(repo, 'base.txt'), 'base'); await git(repo, ['add', '.']);
      await git(repo, ['-c', 'user.name=Fixture', '-c', 'user.email=fixture@localhost', 'commit', '-qm', 'base']);
      const bare = path.join(base, `${id}.git`);
      await git(base, ['clone', '-q', '--bare', repo, bare]); await git(repo, ['remote', 'add', 'origin', bare]);
    }
    await writeFile(path.join(root, 's8-config.yml'), `kbRoot: ${root}\nprojectman:\n  apiUrl: ${apiUrl}/api/v2\ncommunication:\n  enabled: true\n  nodeId: host-${id}\n  credentialsFile: ${credentialFile}\n  managerUrl: ws://127.0.0.1:${port}\n${id === 'manager' ? '  server:\n    bindIp: 127.0.0.1\n    port: ' + port + '\n' : '  repositories:\n    /approved/repo:\n      path: ' + repo + '\n      remote: origin\n'}workers: ${id === 'manager' ? '[]' : '\n  - id: ' + id + '\n    mode: passive'}\n`);
    if (id === 'manager') {
      await run(['new-session', '-d', '-s', 's8-main', '-n', 'communicator', '-c', root, `exec bash ${quote(path.join(root, 's8.sh'))} service communicator`]);
      await run(['set-option', '-w', '-t', 's8-main:communicator', 'remain-on-exit', 'on']);
      await until(async () => (await localRequest(root, 'communicator', { action: 'workers' })).state === 'finished');
      await run(['new-window', '-d', '-t', 's8-main:', '-n', 'pi', '-c', root, `exec bash ${quote(path.join(root, 'start-manager-agent.sh'))}`]);
    } else await exec('bash', [path.join(root, 's8.sh'), 'workers'], { env, timeout: 15_000 });
  }
  return { ...roots, task, calls, notices, get reports() { return reports; } };
}

test('actual CLI runtimes claim, ask and answer through Manager, recover a lost report, and run parallel research', { timeout: 90_000 }, async t => {
  const f = await fixture(t);
  try {
  await until(async () => (await localRequest(f.manager, 'communicator', { action: 'workers' })).workers?.filter(item => item.connected).length === 3);
  await until(async () => (await localRequest(f.manager, 'pi:manager', { action: 'ping' })).state !== 'unavailable');
  const requestIds = ['research-b', 'research-c'];
  const research = await Promise.all(['b', 'c'].map((id, index) => localRequest(f.manager, 'communicator', { action: 'send', workerId: id, type: 'agent.request', payload: { text: 'Compare the evidence; return findings and limitations.' }, context: { requestId: requestIds[index], groupId: 'research-group' } }, { timeoutMs: 15_000 })));
  assert.equal(research.every(result => result.state === 'pending'), true, JSON.stringify(research));
  await until(() => f.notices.filter(input => input.type === 'agent.result').length >= 2);
  assert.equal(new Set(f.notices.filter(input => input.type === 'agent.result').map(input => input.from)).size, 2);
  const sent = await localRequest(f.manager, 'communicator', { action: 'send', workerId: 'a', type: 'task.run', payload: { uid: 'task-1' }, context: { taskUid: 'task-1' } });
  assert.equal(sent.state, 'pending');
  await until(() => f.task.state === 'review');
  const outboxFile = path.join(f.a, '.s8-runtime/runs', f.task.workflow.run.id, 'outbox.json');
  await until(async () => (await readJson(outboxFile))?.delivered === true);
  assert.equal(f.reports, 1, 'lost response must not apply report twice');
  assert.equal(f.task.workflow.result.status, 'completed');
  assert.equal(f.task.workflow.result.checkpoint, '', 'plain reports do not require automatic Git publication');
  assert.equal(f.notices.some(input => input.type === 'agent.request'), true);
  assert.equal(f.notices.some(input => input.type === 'agent.reply'), true);
  // Restart the actual communicator service; existing clients must reconnect without replay.
  await f.managerRun(['send-keys', '-t', 's8-main:communicator', 'C-c']);
  await until(async () => (await localRequest(f.manager, 'communicator', { action: 'workers' })).state === 'unavailable');
  await until(async () => (await f.managerRun(['display-message', '-p', '-t', 's8-main:communicator', '#{pane_dead}'])).stdout.trim() === '1');
  await f.managerRun(['respawn-window', '-t', 's8-main:communicator']);
  await until(async () => (await localRequest(f.manager, 'communicator', { action: 'workers' })).workers?.filter(item => item.connected).length === 3);
  // Restart one real resident without closing its task Pi or replaying assignments.
  await f.aRun(['send-keys', '-t', 's8-workers:worker-a', 'C-c']);
  await until(async () => (await localRequest(f.manager, 'communicator', { action: 'workers' })).workers.some(item => item.id === 'a' && !item.connected));
  await until(async () => (await f.aRun(['display-message', '-p', '-t', 's8-workers:worker-a', '#{pane_dead}'])).stdout.trim() === '1');
  await f.aRun(['respawn-window', '-t', 's8-workers:worker-a']);
  await until(async () => (await localRequest(f.manager, 'communicator', { action: 'workers' })).workers.some(item => item.id === 'a' && item.connected));
  assert.equal([...f.calls.keys()].includes('worker-c'), true);
  assert.equal(f.reports, 1);
  } catch (error) {
    for (const id of ['manager', 'a', 'b', 'c']) {
      const listed = await f[`${id}Run`](['list-windows', '-a', '-F', '#{session_name}:#{window_name}']).catch(() => ({ stdout: '' }));
      for (const target of listed.stdout.trim().split('\n').filter(Boolean)) {
        const pane = await f[`${id}Run`](['capture-pane', '-p', '-S', '-25', '-t', target]).catch(() => ({ stdout: '' }));
        t.diagnostic(`${id} ${target}: ${pane.stdout}`);
      }
    }
    throw error;
  }
});
