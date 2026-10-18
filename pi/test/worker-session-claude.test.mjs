import test from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { PassThrough } from 'node:stream';
import path from 'node:path';
import os from 'node:os';
import { mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { randomUUID } from 'node:crypto';
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
  let capturedArgs, prompt = '';
  const spawnImpl = (_binary, args, options) => {
    capturedArgs = args;
    const child = new EventEmitter();
    child.stdin = new PassThrough(); child.stdout = new PassThrough(); child.stderr = new PassThrough(); child.kill = () => true;
    child.stdin.on('data', chunk => { prompt += chunk.toString(); });
    queueMicrotask(() => {
      child.stdout.write(`${JSON.stringify({ type: 'assistant', message: { content: [{ type: 'tool_use', name: 'mcp__projectman__get' }] } })}\n`);
      child.stdout.write(`${JSON.stringify({ type: 'result', subtype: 'success', is_error: false, structured_output: { status: 'completed', summary: 'done', verification: [{ name: 'fixture', ok: true, summary: 'passed' }], remainingItems: [], decisions: [], executionErrors: [] } })}\n`);
      child.stdout.end(); child.stderr.end(); child.emit('close', 0, null);
    });
    return child;
  };
  const result = await executeClaudeDeveloper({ root, run: { runId, directory, workspace }, task: { uid: 'task-1' } }, { spawnImpl });
  assert.equal(result.report.status, 'completed');
  assert.match(prompt, /Assigned work UID: task-1/);
  assert.ok(capturedArgs.includes('--strict-mcp-config'));
  assert.ok(capturedArgs.includes('--json-schema'));
  assert.equal(capturedArgs.some(arg => ['--max-turns', '--max-budget-usd'].includes(arg)), false);
  const mcp = JSON.parse(await readFile(path.join(directory, 'claude-mcp-config.json'), 'utf8'));
  assert.equal(mcp.mcpServers.projectman.url, '${PHCMS_MCP_URL}');
  assert.equal(mcp.mcpServers.projectman.headers.Authorization, 'Bearer ${PHCMS_ACCESS_TOKEN}');
  const report = JSON.parse(await readFile(path.join(directory, 'worker-result.json'), 'utf8'));
  assert.equal(report.summary, 'done');
  assert.match(await readFile(path.join(directory, 'developer.events.jsonl'), 'utf8'), /mcp__projectman__get/);
});
