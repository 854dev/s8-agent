import test from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { PassThrough } from 'node:stream';
import path from 'node:path';
import os from 'node:os';
import { mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { randomUUID } from 'node:crypto';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import { executeClaudeDeveloper } from '../lib/development/worker-session-claude.mjs';

test('Claude adapter starts an isolated MCP-configured print session and captures structured output without work limits', async t => {
  const root = await mkdtemp(path.join(os.tmpdir(), 's8-claude-worker-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const runId = randomUUID(), workspace = path.join(root, 'workspace'), directory = path.join(root, 'run');
  await mkdir(workspace); await mkdir(directory); await mkdir(path.join(root, 'agents/developer'), { recursive: true });
  await writeFile(path.join(root, 'agents/developer/CLAUDE_WORKER_SYSTEM.md'), 'Use Projectman MCP to read the assigned UID.');
  const oldUrl = process.env.PHCMS_MCP_URL, oldToken = process.env.PHCMS_ACCESS_TOKEN;
  process.env.PHCMS_MCP_URL = 'http://127.0.0.1:3001/mcp';
  process.env.PHCMS_ACCESS_TOKEN = 'fixture-only-token';
  t.after(() => { if (oldUrl === undefined) delete process.env.PHCMS_MCP_URL; else process.env.PHCMS_MCP_URL = oldUrl; if (oldToken === undefined) delete process.env.PHCMS_ACCESS_TOKEN; else process.env.PHCMS_ACCESS_TOKEN = oldToken; });
  let capturedArgs, capturedEnv, prompt = '';
  let state = 'doing';
  const readWorkflow = async () => ({ uid: 'task-1', state, workflow: { run: { id: runId } } });
  const spawnImpl = (_binary, args, options) => {
    capturedArgs = args; capturedEnv = options.env;
    const child = new EventEmitter();
    child.stdin = new PassThrough(); child.stdout = new PassThrough(); child.stderr = new PassThrough(); child.kill = () => true;
    child.stdin.on('data', chunk => { prompt += chunk.toString(); });
    queueMicrotask(async () => {
      const config = JSON.parse(await readFile(args[args.indexOf('--mcp-config') + 1], 'utf8')).mcpServers.projectman;
      const mcp = new Client({ name: 'claude-fixture', version: '1.0.0' });
      await mcp.connect(new StreamableHTTPClientTransport(new URL(config.url), { requestInit: { headers: config.headers } }));
      await mcp.callTool({ name: 'projectman_get_workflow', arguments: { uid: 'task-1' } });
      await mcp.close();
      child.stdout.write(`${JSON.stringify({ type: 'assistant', message: { content: [{ type: 'tool_use', name: 'mcp__projectman__get' }] } })}\n`);
      child.stdout.write(`${JSON.stringify({ type: 'result', subtype: 'success', is_error: false, structured_output: { status: 'completed', summary: 'done', verification: [{ name: 'fixture', ok: true, summary: 'passed' }], remainingItems: [], decisions: [], executionErrors: [] } })}\n`);
      child.stdout.end(); child.stderr.end(); child.emit('close', 0, null);
    });
    return child;
  };
  const result = await executeClaudeDeveloper({ root, run: { runId, directory, workspace }, task: { uid: 'task-1' } }, { spawnImpl, readWorkflow });
  assert.equal(result.report.status, 'completed');
  assert.match(prompt, /Assigned work UID: task-1/);
  assert.ok(capturedArgs.includes('--strict-mcp-config'));
  assert.ok(capturedArgs.includes('--json-schema'));
  assert.equal(capturedArgs.some(arg => ['--max-turns', '--max-budget-usd'].includes(arg)), false);
  const mcp = JSON.parse(await readFile(path.join(directory, 'claude-mcp-config.json'), 'utf8'));
  assert.match(mcp.mcpServers.projectman.url, /^http:\/\/127\.0\.0\.1:\d+\/mcp$/);
  assert.notEqual(mcp.mcpServers.projectman.headers.Authorization, 'Bearer fixture-only-token');
  assert.equal(capturedEnv.PHCMS_ACCESS_TOKEN, undefined);
  assert.equal(capturedEnv.PHCMS_MCP_URL, undefined);
  assert.equal(capturedEnv.PHCMS_API_URL, undefined);
  assert.equal((await fetch(mcp.mcpServers.projectman.url).catch(() => null)), null, 'Scoped MCP closes after the turn');
  const report = JSON.parse(await readFile(path.join(directory, 'worker-result.json'), 'utf8'));
  assert.equal(report.summary, 'done');
  assert.match(await readFile(path.join(directory, 'developer.events.jsonl'), 'utf8'), /mcp__projectman__get/);
});


test('Claude runner rejects unqueried completion and a pre-canceled assignment', async t => {
  const root = await mkdtemp(path.join(os.tmpdir(), 's8-claude-gates-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const directory = path.join(root, 'run');
  await mkdir(directory); await mkdir(path.join(root, 'agents/developer'), { recursive: true });
  await writeFile(path.join(root, 'agents/developer/CLAUDE_WORKER_SYSTEM.md'), 'Read assigned work');
  const request = { root, run: { runId: randomUUID(), directory, workspace: root }, task: { uid: 'task-1' } };
  const readWorkflow = async () => ({ uid: 'task-1', state: 'doing', workflow: { run: { id: request.run.runId } } });
  let spawns = 0;
  const spawnImpl = () => {
    spawns++;
    const child = new EventEmitter();
    child.stdin = new PassThrough(); child.stdout = new PassThrough(); child.stderr = new PassThrough(); child.kill = () => true;
    queueMicrotask(() => {
      child.stdout.end(JSON.stringify({ type: 'result', subtype: 'success', structured_output: { status: 'completed', summary: 'Skipped Projectman' } }) + '\n');
      child.stderr.end(); child.emit('close', 0, null);
    });
    return child;
  };
  await assert.rejects(executeClaudeDeveloper(request, { spawnImpl, readWorkflow }), /did not retrieve/);
  await assert.rejects(readFile(path.join(directory, 'worker-result.json')), { code: 'ENOENT' });
  await assert.rejects(executeClaudeDeveloper(request, { spawnImpl, readWorkflow, signal: AbortSignal.abort() }), /abort/i);
  await assert.rejects(executeClaudeDeveloper(request, { spawnImpl, readWorkflow: async () => ({ state: 'blocked' }) }), /no longer active/);
  assert.equal(spawns, 1);
});

test('Claude runner terminates its child when an oversized event aborts protocol processing', async t => {
  const root = await mkdtemp(path.join(os.tmpdir(), 's8-claude-protocol-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const directory = path.join(root, 'run');
  await mkdir(directory); await mkdir(path.join(root, 'agents/developer'), { recursive: true });
  await writeFile(path.join(root, 'agents/developer/CLAUDE_WORKER_SYSTEM.md'), 'Read assigned work');
  const request = { root, run: { runId: randomUUID(), directory, workspace: root }, task: { uid: 'task-1' } };
  let stopped = false;
  const spawnImpl = () => {
    const child = new EventEmitter();
    child.stdin = new PassThrough(); child.stdout = new PassThrough(); child.stderr = new PassThrough();
    child.kill = () => {
      stopped = true;
      queueMicrotask(() => { child.stdout.end(); child.stderr.end(); child.emit('close', 1, 'SIGTERM'); });
      return true;
    };
    queueMicrotask(() => child.stdout.write('x'.repeat(4 * 1024 * 1024 + 1) + '\n'));
    return child;
  };
  await assert.rejects(executeClaudeDeveloper(request, { spawnImpl, readWorkflow: async () => ({ state: 'doing', workflow: { run: { id: request.run.runId } } }) }), /protocol limit/);
  assert.equal(stopped, true);
});
