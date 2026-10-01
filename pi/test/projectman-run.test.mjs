import assert from 'node:assert/strict';
import { test } from 'node:test';
import { createServer } from 'node:http';
import { mkdtemp, writeFile, chmod, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { runProjectmanResearch } from '../lib/projectman-run.ts';

const cwd = path.resolve(process.cwd(), '../854_md');
const item = (uid, type, attrs = {}, tags = []) => ({
  uid, type, title: uid, status: 'published', created_at: '2026-01-01', updated_at: null,
  tags, detail: { text: 'Read docs and cite sources', attributes: attrs },
});

async function fixture(fn) {
  const project = item('project-1', 'project', { repoPath: process.cwd() });
  const task = item('task-1', 'task', {
    state: 'ready', autorun: true, autorunMode: 'safe', risk: 'low', requiresApproval: false, allowedActions: ['read'],
  });
  const logs = [];
  const subtasks = [];
  const server = createServer(async (req, res) => {
    if (req.headers.authorization !== 'Bearer test-token') { res.writeHead(401).end(); return; }
    const url = new URL(req.url, 'http://localhost');
    if (req.method === 'GET' && url.pathname.endsWith('/contents')) {
      const uid = url.searchParams.get('uids');
      let content = uid ? [project, task, ...subtasks].filter(row => row.uid === uid) :
        url.searchParams.get('type') === 'task' ? [task] : url.searchParams.get('type') === 'subtask' ? subtasks : logs;
      if (url.searchParams.get('parentUid') === 'project-1' && url.searchParams.get('type') !== 'task') content = [];
      res.setHeader('content-type', 'application/json');
      res.end(JSON.stringify({ content, last: true }));
    } else if (req.method === 'POST' && url.pathname.endsWith('/transitions')) {
      let body = '';
      for await (const chunk of req) body += chunk;
      const input = JSON.parse(body);
      if (task.detail.attributes.state !== input.expectedState) { res.writeHead(409).end(); return; }
      task.detail.attributes.state = input.nextState;
      logs.push({ event: input.event, message: input.message });
      res.setHeader('content-type', 'application/json');
      res.end(JSON.stringify({ uid: task.uid, fromState: input.expectedState, toState: input.nextState, workLogUid: `log-${logs.length}`, requestId: input.requestId }));
    } else res.writeHead(404).end();
  });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  const previous = [process.env.PHCMS_API_URL, process.env.PHCMS_ACCESS_TOKEN];
  process.env.PHCMS_API_URL = `http://127.0.0.1:${server.address().port}/api/v2`;
  process.env.PHCMS_ACCESS_TOKEN = 'test-token';
  const dir = await mkdtemp(path.join(tmpdir(), 'projectman-smoke-'));
  const binary = path.join(dir, 'fake-pi');
  const paths = { cwd, binary, guard: 'guard.ts', scopeExtension: 'read-scope.ts', systemPrompt: 'instructions.md' };
  try { await fn({ task, project, logs, subtasks, binary, paths }); }
  finally {
    if (previous[0] === undefined) delete process.env.PHCMS_API_URL; else process.env.PHCMS_API_URL = previous[0];
    if (previous[1] === undefined) delete process.env.PHCMS_ACCESS_TOKEN; else process.env.PHCMS_ACCESS_TOKEN = previous[1];
    await new Promise(resolve => server.close(resolve));
    await rm(dir, { recursive: true, force: true });
  }
}

test('one independent research task is logged and sent to review', () => fixture(async ({ task, logs, binary, paths }) => {
  await writeFile(binary, '#!/usr/bin/env node\nconsole.log("Checked README.md")\n');
  await chmod(binary, 0o700);
  const result = await runProjectmanResearch('project-1', 1, new AbortController().signal, paths);
  assert.equal(result.status, 'review');
  assert.equal(task.detail.attributes.state, 'review');
  assert.deepEqual(logs.map(log => log.event), ['started', 'completed']);
  assert.match(logs[1].message, /README.md/);
}));

test('long model output fits the PH-CMS transition message limit', () => fixture(async ({ task, logs, binary, paths }) => {
  await writeFile(binary, '#!/usr/bin/env node\nconsole.log("x".repeat(12000))\n');
  await chmod(binary, 0o700);
  const result = await runProjectmanResearch('project-1', 1, new AbortController().signal, paths);
  assert.equal(result.status, 'review');
  assert.equal(task.detail.attributes.state, 'review');
  assert.ok(logs[1].message.length <= 10000);
}));

test('user stop kills the child and records a blocked state', () => fixture(async ({ task, logs, binary, paths }) => {
  await writeFile(binary, '#!/usr/bin/env node\nsetInterval(() => {}, 1000)\n');
  await chmod(binary, 0o700);
  const controller = new AbortController();
  const run = runProjectmanResearch('project-1', 1, controller.signal, paths);
  setTimeout(() => controller.abort(), 500);
  const result = await run;
  assert.equal(result.status, 'blocked');
  assert.equal(task.detail.attributes.state, 'blocked');
  assert.deepEqual(logs.map(log => log.event), ['started', 'blocked']);
}));

test('deadline ends the child and records incomplete work', () => fixture(async ({ task, logs, binary, paths }) => {
  await writeFile(binary, '#!/usr/bin/env node\nsetInterval(() => {}, 1000)\n');
  await chmod(binary, 0o700);
  const result = await runProjectmanResearch('project-1', 0.01, new AbortController().signal, paths);
  assert.equal(result.status, 'blocked');
  assert.equal(task.detail.attributes.state, 'blocked');
  assert.deepEqual(logs.map(log => log.event), ['started', 'blocked']);
}));

test('approval tag and feature subtasks stop unattended execution', () => fixture(async ({ task, logs, subtasks, paths }) => {
  task.tags.push('need:approval');
  assert.equal((await runProjectmanResearch('project-1', 1, new AbortController().signal, paths)).status, 'empty');
  task.tags.length = 0;
  subtasks.push(item('sub-1', 'subtask', { state: 'ready' }));
  assert.equal((await runProjectmanResearch('project-1', 1, new AbortController().signal, paths)).status, 'empty');
  assert.deepEqual(logs, []);
  assert.equal(task.detail.attributes.state, 'ready');
}));
