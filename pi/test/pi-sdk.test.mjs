import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { mkdtemp, mkdir, readFile, copyFile, rm, writeFile } from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { Type } from 'typebox';
import { ModelRuntime } from '@earendil-works/pi-coding-agent';
import { openManagerSession } from './helpers/manager-session.mjs';
import { runModelSession } from './helpers/model-session.mjs';
import { developmentWorkspace } from '../lib/development/workspace.mjs';

// Exercise the installed SDK's real HTTP streaming, tool dispatch and session
// records using a local provider. No account credentials or external API calls.
async function fixture(t, tool) {
  const root = await mkdtemp(path.join(os.tmpdir(), 's8-pi-sdk-'));
  await mkdir(path.join(root, 'src'));
  await mkdir(path.join(root, 'agents/manager'), { recursive: true });
  await copyFile(new URL('../../agents/manager/SYSTEM.md', import.meta.url), path.join(root, 'agents/manager/SYSTEM.md'));
  const requests = [];
  const server = http.createServer(async (req, res) => {
    let raw = ''; for await (const chunk of req) raw += chunk;
    const body = JSON.parse(raw); requests.push(body);
    assert.equal(req.url, '/v1/chat/completions');
    assert.equal(req.headers.authorization, 'Bearer fixture-key');
    res.writeHead(200, { 'content-type': 'text/event-stream' });
    const emit = (delta, finish_reason = null) => res.write(`data: ${JSON.stringify({ id: `fixture-${requests.length}`, object: 'chat.completion.chunk', model: 'fixture', choices: [{ index: 0, delta, finish_reason }] })}\n\n`);
    emit({ role: 'assistant' });
    const step = (Array.isArray(tool) ? tool : [tool])[requests.length - 1];
    if (step) {
      emit({ tool_calls: [{ index: 0, id: 'call_fixture', type: 'function', function: { name: step.name, arguments: JSON.stringify(step.args) } }] });
      emit({}, 'tool_calls');
    } else { emit({ content: 'SDK 검증 완료' }); emit({}, 'stop'); }
    res.end('data: [DONE]\n\n');
  });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  t.after(async () => { server.closeAllConnections(); await new Promise(resolve => server.close(resolve)); await rm(root, { recursive: true, force: true }); });
  const runtime = await ModelRuntime.create({ authPath: path.join(root, 'auth.json'), modelsPath: path.join(root, 'models.json'), refreshOnCreate: false });
  runtime.registerProvider('s8-fixture', { api: 'openai-completions', apiKey: 'fixture-key', authHeader: true, baseUrl: `http://127.0.0.1:${server.address().port}/v1`, models: [{ id: 'fixture', name: 'Fixture', reasoning: false, input: ['text'], contextWindow: 32768, maxTokens: 1024, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 } }] });
  return { root, requests, runtime, model: runtime.getModel('s8-fixture', 'fixture') };
}

test('manager streams through the installed Pi SDK and executes its bash tool', async t => {
  const f = await fixture(t, { name: 'bash', args: { command: 'printf manager-sdk-ok' } });
  const previous = process.env.S8_PI_CONFIG_ROOT;
  process.env.S8_PI_CONFIG_ROOT = path.join(f.root, 'pi');
  t.after(() => { if (previous === undefined) delete process.env.S8_PI_CONFIG_ROOT; else process.env.S8_PI_CONFIG_ROOT = previous; });
  const directory = path.join(f.root, 'manager');
  const session = await openManagerSession({ root: f.root, cwd: f.root, directory, modelRuntime: f.runtime, model: f.model, poll: false });
  try { assert.equal(await session.prompt('Run the local fixture command.', AbortSignal.timeout(10000)), 'SDK 검증 완료'); }
  finally { await session.close(); }
  assert.equal(f.requests.length, 2);
  assert.ok(f.requests[1].messages.some(message => message.role === 'tool' && JSON.stringify(message.content).includes('manager-sdk-ok')));
  const events = (await readFile(path.join(directory, 'manager.events.jsonl'), 'utf8')).trim().split('\n').map(JSON.parse);
  assert.ok(events.some(event => event.type === 'tool_execution_end' && !event.isError));
});

test('developer SDK streams a scoped workspace write and records the real tool result', async t => {
  const f = await fixture(t, { name: 'workspace', args: { path: 'src/result.txt', content: 'developer-sdk-ok' } });
  const workspace = developmentWorkspace(f.root);
  const tool = { name: 'workspace', label: 'Workspace', description: 'Write a fixture file within the approved src directory.', parameters: Type.Object({ path: Type.String(), content: Type.String() }), async execute(_id, args) { return { content: [{ type: 'text', text: JSON.stringify(await workspace.write(args.path, args.content)) }] }; } };
  const result = await runModelSession({ role: 'developer', prompt: 'Write the approved fixture file.', systemPrompt: 'Perform the approved task.', tools: [tool], runtime: f.runtime, model: f.model, run: { directory: f.root, workspace: f.root }, signal: AbortSignal.timeout(10000) });
  assert.equal(result, 'SDK 검증 완료');
  assert.equal(await readFile(path.join(f.root, 'src/result.txt'), 'utf8'), 'developer-sdk-ok');
  const events = (await readFile(path.join(f.root, 'developer.events.jsonl'), 'utf8')).trim().split('\n').map(JSON.parse);
  assert.ok(events.some(event => event.type === 'tool_execution_end' && !event.isError));
});


test('worker SDK queries its assigned UID, writes in its worktree and blocks changes after report', async t => {
  const { executeDeveloper } = await import('../lib/development/worker-session.mjs');
  const runId = '11111111-1111-4111-8111-111111111111';
  const f = await fixture(t, [
    { name: 'projectman', args: { action: 'get', uid: 'task-1' } },
    { name: 'write', args: { path: 'src/result.txt', content: 'worker-pool-sdk-ok' } },
    { name: 'projectman', args: { action: 'report', uid: 'task-1', status: 'completed', summary: 'Verified implementation', verification: [] } },
    { name: 'write', args: { path: 'src/result.txt', content: 'must not write' } },
  ]);
  await mkdir(path.join(f.root, 'agents/developer'), { recursive: true });
  await mkdir(path.join(f.root, 'pi'));
  await writeFile(path.join(f.root, 'pi/settings.json'), JSON.stringify({ defaultProvider: 's8-fixture', defaultModel: 'fixture' }));
  await copyFile(new URL('../../agents/developer/WORKER_SYSTEM.md', import.meta.url), path.join(f.root, 'agents/developer/WORKER_SYSTEM.md'));
  const result = await executeDeveloper({ root: f.root, task: { uid: 'task-1' }, run: { runId, workspace: f.root, directory: f.root } }, {
    signal: AbortSignal.timeout(10000), runtimeFactory: async () => ({ runtime: f.runtime, model: f.model }),
    client: { getWorkflow: async uid => ({ uid, state: 'doing', workflow: { run: { id: runId }, spec: { plan: 'Implement and verify' } } }) },
  });
  assert.equal(result.report.status, 'completed');
  assert.equal(await readFile(path.join(f.root, 'src/result.txt'), 'utf8'), 'worker-pool-sdk-ok');
  const report = JSON.parse(await readFile(path.join(f.root, 'worker-result.json'), 'utf8'));
  assert.equal(report.summary, 'Verified implementation');
  assert.ok(f.requests.at(-1).messages.some(message => message.role === 'tool' && JSON.stringify(message.content).includes('no changes after reporting')));
});
