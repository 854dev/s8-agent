import test from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import os from 'node:os';
import { mkdtemp, mkdir, writeFile, rm, readFile } from 'node:fs/promises';
import { randomUUID } from 'node:crypto';
import { startDeveloperWorker } from '../lib/development/worker-daemon.mjs';
import { workerRequest } from '../lib/development/worker-pool.mjs';
import { drainManagerInbox } from '../lib/manager/inbox.mjs';

const until = async check => { for (let i = 0; i < 100; i++) { if (await check()) return; await new Promise(resolve => setTimeout(resolve, 10)); } assert.fail('condition timeout'); };

test('persistent worker accepts one UID, survives duplicate delivery, and waits for release before another', async t => {
  const root = await mkdtemp(path.join(os.tmpdir(), 's8-worker-'));
  let complete, executions = 0;
  const worker = await startDeveloperWorker(root, 'worker-1', { executeWork: async request => { executions++; await new Promise(resolve => { complete = resolve; }); await writeFile(path.join(request.run.directory, 'worker-result.json'), JSON.stringify({ status: 'completed', summary: 'done' })); } });
  t.after(async () => { await worker.close(); await rm(root, { recursive: true, force: true }); });
  async function assignment(uid) {
    const runId = randomUUID(), directory = path.join(root, '.s8-runtime/runs', runId);
    await mkdir(directory, { recursive: true });
    await writeFile(path.join(directory, 'request.json'), JSON.stringify({ task: { uid }, workerId: 'worker-1', run: { runId, directory } }));
    return { action: 'assign', uid, runId };
  }
  const first = await assignment('task-1'), second = await assignment('task-2');
  assert.equal((await workerRequest(root, 'worker-1', first)).accepted, true);
  await until(() => complete);
  assert.equal((await workerRequest(root, 'worker-1', first)).accepted, true);
  await assert.rejects(workerRequest(root, 'worker-1', second));
  assert.equal(executions, 1);
  complete();
  await until(() => worker.state().status === 'reported');
  await assert.rejects(workerRequest(root, 'worker-1', second));
  await workerRequest(root, 'worker-1', { action: 'release', runId: first.runId });
  assert.equal((await workerRequest(root, 'worker-1', { action: 'release', runId: first.runId })).released, true);
  await assert.rejects(workerRequest(root, 'worker-1', first));
  await workerRequest(root, 'worker-1', second);
  await until(() => executions === 2);
  complete();
  await until(() => worker.state().status === 'reported');
});

test('manager inbox has one consumer and persists receipt across restart', async t => {
  const root = await mkdtemp(path.join(os.tmpdir(), 's8-inbox-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const directory = path.join(root, '.s8-runtime/manager-inbox');
  await mkdir(directory, { recursive: true });
  const file = path.join(directory, `${randomUUID()}.json`);
  await writeFile(file, JSON.stringify({ uid: 'task-1', runId: 'run' }));
  let deliveries = 0;
  const receive = async () => { deliveries++; await new Promise(resolve => setTimeout(resolve, 20)); };
  await Promise.all([drainManagerInbox(root, receive), drainManagerInbox(root, receive)]);
  await drainManagerInbox(root, receive);
  assert.equal(deliveries, 1);
  assert.ok(JSON.parse(await readFile(file, 'utf8')).receivedAt);
});

test('two persistent workers dispatch three approved UIDs and reuse a free slot while the other is busy', async t => {
  const { execFile } = await import('node:child_process');
  const { promisify } = await import('node:util');
  const { developmentTick, waitForDevelopmentRuns, recoverDevelopmentRuns } = await import('../lib/development/supervisor.mjs');
  const { saveJson } = await import('../lib/storage/json-file.mjs');
  const exec = promisify(execFile);
  const root = await mkdtemp(path.join(os.tmpdir(), 's8-pool-integration-'));
  const repo = path.join(root, 'repo');
  await mkdir(repo);
  await writeFile(path.join(root, 's8-config.yml'), 'telegram: {}\nworkers:\n  count: 2\n');
  await writeFile(path.join(repo, 'base.txt'), 'original');
  for (const args of [['init'], ['add', '.'], ['-c', 'user.name=Fixture', '-c', 'user.email=fixture@example.invalid', 'commit', '-m', 'fixture']]) await exec('git', args, { cwd: repo });
  const rows = new Map(Array.from({ length: 3 }, (_, i) => [`task-${i}`, {
    uid: `task-${i}`, state: 'ready', title: `Task ${i}`, workflow: { version: 2, revision: 1, planHash: 'plan', planVersion: 1,
      specHash: 'spec', confirmation: { planHash: 'plan', planVersion: 1 }, grant: { specHash: 'spec' },
      spec: { repoPath: repo, plan: 'Write one file', commandNames: [], dependsOn: [] } },
  }]));
  const applied = new Map(), starts = [];
  const client = {
    getWorkflow: async uid => structuredClone(rows.get(uid)),
    list: async type => type === 'task' ? [...rows.values()].filter(row => row.state === 'ready').map(row => ({ uid: row.uid, detail: { attributes: { workflow: row.workflow } } })) : [],
    workflow: async (uid, operation) => {
      if (applied.has(operation.requestId)) return structuredClone(applied.get(operation.requestId));
      const row = rows.get(uid);
      assert.equal(operation.expectedRevision, row.workflow.revision);
      if (operation.action === 'claim') {
        assert.equal(row.state, 'ready'); row.state = 'doing'; row.workflow.run = { id: operation.runId, workerId: operation.workerId };
      } else {
        assert.equal(row.state, 'doing'); assert.equal(row.workflow.run.id, operation.runId);
        row.state = operation.report.status === 'completed' ? 'review' : 'blocked'; row.workflow.result = operation.report;
      }
      row.workflow.revision++;
      const response = structuredClone(row); applied.set(operation.requestId, response); return response;
    },
  };
  let releaseFirst;
  const first = new Promise(resolve => { releaseFirst = resolve; });
  const executeWork = async request => {
    starts.push({ uid: request.task.uid, workerId: request.workerId });
    if (request.task.uid === 'task-0') await first;
    if (request.task.uid === 'task-2') {
      assert.equal(rows.get('task-0').state, 'doing');
      releaseFirst();
    }
    await writeFile(path.join(request.run.workspace, `${request.task.uid}.txt`), 'done');
    await saveJson(path.join(request.run.directory, 'worker-result.json'), { status: 'completed', summary: 'done', verification: [] });
  };
  const workers = await Promise.all(['worker-1', 'worker-2'].map(id => startDeveloperWorker(root, id, { executeWork })));
  t.after(async () => { releaseFirst(); await waitForDevelopmentRuns(root); await Promise.all(workers.map(worker => worker.close())); await rm(root, { recursive: true, force: true }); });
  const options = { root, client, policy: { maxConcurrency: 2 } };
  for (let i = 0; i < 300 && [...rows.values()].some(row => row.state !== 'review'); i++) {
    await developmentTick(options); await recoverDevelopmentRuns(options);
    await new Promise(resolve => setTimeout(resolve, 10));
  }
  await waitForDevelopmentRuns(root);
  assert.ok([...rows.values()].every(row => row.state === 'review'));
  assert.equal(starts.length, 3);
  assert.equal(starts.find(item => item.uid === 'task-1').workerId, starts.find(item => item.uid === 'task-2').workerId);
  assert.equal((await exec('git', ['status', '--porcelain'], { cwd: repo })).stdout, '');
});
