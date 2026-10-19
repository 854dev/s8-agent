import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { claimWork, reportWork } from '../lib/agent/worker-run.mjs';
import worker from '../extensions/worker.ts';

/** 요청 ID로 멱등 처리하는 Projectman 가짜 클라이언트. loseNext면 다음 변경을 반영한 뒤 응답만 잃는다. */
async function fixture(t, { type = 'task', state = 'ready', commandNames = [] } = {}) {
  const root = await mkdtemp(path.join(os.tmpdir(), 's8-worker-mode-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const row = { uid: 'task1', title: 'Fixture', state, workflow: { version: 2, revision: 2, planVersion: 1, planHash: 'p', confirmation: { planVersion: 1, planHash: 'p' }, specHash: 's', grant: { specHash: 's' }, spec: { plan: 'Do it', commandNames } } };
  const applied = new Map(), operations = [];
  const client = {
    loseNext: false,
    get: async uid => ({ uid, type, title: row.title, detail: { text: 'Write the file' } }),
    getWorkflow: async () => structuredClone(row),
    async workflow(_uid, operation) {
      if (!applied.has(operation.requestId)) {
        if (row.workflow.revision !== operation.expectedRevision) throw new Error('PH-CMS request failed (HTTP 409)');
        operations.push(operation);
        if (operation.action === 'claim') { row.state = 'doing'; row.workflow.run = { id: operation.runId, workerId: operation.workerId }; }
        else { row.state = operation.report.status === 'completed' ? 'review' : 'blocked'; row.workflow.result = operation.report; }
        row.workflow.revision++;
        applied.set(operation.requestId, structuredClone(row));
      }
      if (this.loseNext) { this.loseNext = false; throw new Error('PH-CMS request failed (timeout)'); }
      return structuredClone(applied.get(operation.requestId));
    },
  };
  return { root, row, client, operations };
}

test('worker claims a ready task once, retrying a lost response with the same request', async t => {
  const f = await fixture(t);
  f.client.loseNext = true;
  await assert.rejects(claimWork({ root: f.root, client: f.client, uid: 'task1', workerId: 'w1' }), /timeout/);
  const { claim, work } = await claimWork({ root: f.root, client: f.client, uid: 'task1', workerId: 'w1' });
  assert.equal(f.operations.length, 1);
  assert.equal(f.row.workflow.run.workerId, 'w1');
  assert.equal(work.runId, claim.runId);
  assert.equal(work.text, 'Write the file');
  // 같은 장비에서 다시 get하면 claim 없이 이어간다.
  assert.equal((await claimWork({ root: f.root, client: f.client, uid: 'task1' })).claim.runId, claim.runId);
  assert.equal(f.operations.length, 1);
});

test('worker refuses non-work items, unready tasks and revoked runs', async t => {
  const project = await fixture(t, { type: 'project' });
  await assert.rejects(claimWork({ root: project.root, client: project.client, uid: 'task1' }), /task 또는 subtask/);
  const todo = await fixture(t, { state: 'todo' });
  await assert.rejects(claimWork({ root: todo.root, client: todo.client, uid: 'task1' }), /ready/);
  const revoked = await fixture(t);
  await claimWork({ root: revoked.root, client: revoked.client, uid: 'task1' });
  revoked.row.workflow.run.id = 'someone-else';
  await assert.rejects(claimWork({ root: revoked.root, client: revoked.client, uid: 'task1' }), /유효하지 않습니다/);
});

test('report is delivered once through the outbox and missing required checks fail the work', async t => {
  const f = await fixture(t, { commandNames: ['test'] });
  const { claim } = await claimWork({ root: f.root, client: f.client, uid: 'task1' });
  const outcome = await reportWork({ root: f.root, client: f.client, claim, cwd: f.root, result: { status: 'completed', summary: 'done', verification: [] } });
  assert.deepEqual(outcome, { status: 'failed', delivered: true, conflict: false, state: 'blocked' });
  const outbox = JSON.parse(await readFile(path.join(f.root, '.s8-runtime/runs', claim.runId, 'outbox.json'), 'utf8'));
  assert.equal(outbox.operation.expectedRevision, claim.revision);
  assert.equal(f.operations.filter(op => op.action === 'report').length, 1);
  await assert.rejects(claimWork({ root: f.root, client: f.client, uid: 'task1' }), /이미 보고/);
});

test('worker extension gates tools on claim and report and stays on one UID', async t => {
  const f = await fixture(t);
  const tools = new Map(), handlers = {};
  const pi = { registerTool: tool => tools.set(tool.name, tool), on: (name, handler) => { handlers[name] = handler; }, setActiveTools() {} };
  worker(pi, { root: f.root, client: f.client, workerId: 'w1' });
  assert.ok(tools.has('bash'), 'bash is replaced by a secret-stripping variant');
  const projectman = tools.get('projectman'), ctx = { cwd: f.root };
  const call = toolName => handlers.tool_call({ toolName, input: {} });
  assert.equal((await call('edit')).block, true);
  assert.equal((await call('kb')).block, true);
  await projectman.execute('1', { action: 'get', uid: 'task1' }, undefined, undefined, ctx);
  assert.equal(await call('edit'), undefined);
  await assert.rejects(projectman.execute('2', { action: 'get', uid: 'task2' }, undefined, undefined, ctx), /task1만/);
  await projectman.execute('3', { action: 'report', uid: 'task1', status: 'completed', summary: 'done', verification: [] }, undefined, undefined, ctx);
  assert.equal(f.row.state, 'review');
  assert.equal((await call('bash')).block, true);
  await assert.rejects(projectman.execute('4', { action: 'report', uid: 'task1', status: 'completed', summary: 'again' }, undefined, undefined, ctx), /이미 보고/);
});
