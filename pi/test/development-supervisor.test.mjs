import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, writeFile, readFile, readdir, rm } from 'node:fs/promises';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import path from 'node:path';
import os from 'node:os';
import { randomUUID } from 'node:crypto';
import { preflightFingerprint } from '../lib/projectman/preflight.mjs';
import { developmentTick, runDevelopmentTask, flushDevelopmentOutbox, recoverDevelopmentRuns, reportForServer, runDevelopmentLoop } from '../lib/development/supervisor.mjs';
import { developmentWorkspace, workspaceChanges } from '../lib/development/workspace.mjs';

const exec = promisify(execFile);

test('report truncation retains failures and never converts failed verification to completion', () => {
  const verification = [{ name: 'first failure', ok: false, summary: 'failed' }, ...Array.from({ length: 25 }, (_, index) => ({ name: `passed-${index}`, ok: true }))];
  const report = reportForServer({ status: 'completed', summary: 'fixture', verification });
  assert.equal(report.status, 'failed');
  assert.equal(report.verification.length, 20);
  assert.equal(report.verification[0].ok, false);
  assert.ok(report.executionErrors.length);
});

test('supervisor retries transient Projectman failures and leaves permanent errors visible', async t => {
  const f = await fixture(t), controller = new AbortController();
  let calls = 0, retries = 0;
  f.client.list = async () => {
    if (++calls === 1) throw Object.assign(new Error('PH-CMS request failed (HTTP 503)'), { status: 503 });
    controller.abort();
    return [];
  };
  await runDevelopmentLoop({ ...f, signal: controller.signal, intervalMs: 1, onRetry: () => retries++ });
  assert.equal(retries, 1);
  assert.ok(calls >= 2);
  f.client.list = async () => { throw Object.assign(new Error('PH-CMS request failed (HTTP 403)'), { status: 403 }); };
  await assert.rejects(runDevelopmentLoop({ ...f, once: true }), /HTTP 403/);
});
async function fixture(t, count = 1) {
  const base = await mkdtemp(path.join(os.tmpdir(), 's8-supervisor-'));
  t.after(() => rm(base, { recursive: true, force: true }));
  const root = path.join(base, 'agent'), repo = path.join(base, 'repo');
  await mkdir(root); await mkdir(repo); await mkdir(path.join(repo, 'src'));
  await writeFile(path.join(repo, 'src/base.txt'), 'base');
  for (const args of [['init'], ['add', '.'], ['-c', 'user.name=Fixture', '-c', 'user.email=fixture@example.invalid', 'commit', '-m', 'fixture']]) await exec('git', args, { cwd: repo });
  const rows = new Map(Array.from({ length: count }, (_, i) => [`task${i}`, { uid: `task${i}`, title: 'Fixture', text: 'Write isolated file', state: 'ready', workflow: { version: 2, planVersion: 1, planHash: 'fixture', confirmation: { planVersion: 1, planHash: 'fixture', actorUid: 'human' }, revision: 2, spec: { plan: 'Requirements and scope resolved before final approval.', repoPath: repo, commandNames: [], dependsOn: [], timeBudgetMinutes: 1 }, grant: { specHash: 'fixture' }, specHash: 'fixture' } }]));
  const content = row => ({ uid: row.uid, title: row.title, detail: { text: row.text, attributes: { state: row.state, workflow: row.workflow, s8Preflight: row.s8Preflight } } });
  for (const row of rows.values()) row.s8Preflight = { status: 'reviewed', specHash: row.workflow.specHash, fingerprint: preflightFingerprint(content(row), row.workflow), summary: 'Requirements and scope resolved before final approval.' };
  const applied = new Map(), reports = [];
  const client = {
    get: async uid => structuredClone(content(rows.get(uid))),
    getWorkflow: async uid => structuredClone(rows.get(uid)),
    list: async type => type === 'task' ? [...rows.values()].filter(row => row.state === 'ready').map(row => ({ uid: row.uid, detail: { attributes: { workflow: structuredClone(row.workflow) } } })) : [],
    workflow: async (uid, operation) => {
      if (applied.has(operation.requestId)) return structuredClone(applied.get(operation.requestId));
      const row = rows.get(uid);
      if (row.workflow.revision !== operation.expectedRevision) throw new Error('PH-CMS request failed (HTTP 409)');
      if (operation.action === 'claim') {
        if (row.state !== 'ready') throw new Error('PH-CMS request failed (HTTP 409)');
        row.state = 'doing'; row.workflow.run = { id: operation.runId };
      } else if (operation.action === 'report') {
        if (row.state !== 'doing' || row.workflow.run.id !== operation.runId) throw new Error('PH-CMS request failed (HTTP 409)');
        row.state = operation.report.status === 'completed' ? 'review' : 'blocked'; row.workflow.result = operation.report; reports.push(operation);
      } else if (operation.action === 'request_review') { row.state = 'blocked'; row.workflow.review = { pending: true, ...operation.question }; }
      row.workflow.revision++;
      const response = structuredClone(row); applied.set(operation.requestId, response); return response;
    },
  };
  const workerEntries = Object.fromEntries(Array.from({ length: count }, (_, index) => [`worker-${index + 1}`, { agent: 'pi', host: 'local', launch: 'managed' }]));
  const policy = { workerEntries };
  return { base, root, repo, rows, client, reports, policy };
}

test('two real Git worktrees run concurrently without changing the source repository', async t => {
  const f = await fixture(t, 2); let active = 0, max = 0;
  const worker = async request => {
    assert.match(request.preflight.summary, /Requirements and scope resolved/);
    max = Math.max(max, ++active);
    await developmentWorkspace(request.run.workspace).write(`src/${request.task.uid}.txt`, request.task.uid);
    await new Promise(resolve => setTimeout(resolve, 80)); active--;
    return { report: { status: 'completed', summary: 'Changed isolated workspace', verification: [] } };
  };
  const results = await developmentTick({ ...f, worker });
  assert.equal(max, 2); assert.equal(results.length, 2); assert.equal(f.reports.length, 2);
  assert.deepEqual([...f.rows.values()].map(row => row.state), ['review', 'review']);
  assert.equal((await exec('git', ['status', '--porcelain'], { cwd: f.repo })).stdout, '');
  assert.equal((await readdir(path.join(f.repo, 'src'))).length, 1);
  for (const result of results) assert.equal((await workspaceChanges(result.worktree)).changedFiles.length, 1);
  for (const result of results) await exec('git', ['apply', '--check', path.join(f.root, '.s8-runtime/runs', result.runId, 'changes.patch')], { cwd: f.repo });
});

test('lost report response is replayed from durable outbox without running the developer twice', async t => {
  const f = await fixture(t); const apply = f.client.workflow; let lost = true, executions = 0;
  f.client.workflow = async (uid, operation) => {
    const result = await apply(uid, operation);
    if (operation.action === 'report' && lost) { lost = false; throw new Error('Response lost'); }
    return result;
  };
  await developmentTick({ ...f, worker: async () => { executions++; return { report: { status: 'completed', summary: 'done', verification: [] } }; } });
  assert.equal(executions, 1);
  const flushed = await flushDevelopmentOutbox(f);
  assert.equal(flushed[0].delivered, true); assert.equal(f.reports.length, 1);
  await developmentTick({ ...f, worker: async () => { throw new Error('Must not rerun'); } });
  assert.equal(executions, 1);
});

test('missing or outdated human plan confirmation never starts a worker', async t => {
  const f = await fixture(t);
  const row = f.rows.get('task0');
  for (const invalidate of [() => { row.workflow.planHash = 'changed'; }, () => { delete row.workflow.confirmation; }]) {
    invalidate();
    const result = await runDevelopmentTask({ ...f, candidate: { uid: 'task0' }, worker: async () => { assert.fail('Must not execute before manager review'); } });
    assert.equal(result.status, 'preflight_required');
    assert.equal(row.state, 'ready');
    assert.equal(f.reports.length, 0);
  }
});

test('incomplete reports become failed work and never execute automatically again', async t => {
  const f = await fixture(t); let executions = 0;
  const worker = async () => { executions++; return { report: { status: 'continue', summary: 'Unfinished implementation', question: { question: 'Legacy question' } } }; };
  await developmentTick({ ...f, worker });
  assert.equal(f.rows.get('task0').state, 'blocked');
  assert.equal(f.reports[0].report.status, 'failed');
  assert.equal(f.reports[0].report.question, undefined);
  await developmentTick({ ...f, worker });
  assert.equal(executions, 1);
});

test('dirty source repository does not block execution or change user files', async t => {
  const f = await fixture(t); await writeFile(path.join(f.repo, 'src/base.txt'), 'user changes');
  const result = await runDevelopmentTask({ ...f, candidate: { uid: 'task0' }, worker: async request => {
    const workspace = developmentWorkspace(request.run.workspace);
    await workspace.write('other/new.txt', 'Outside the old allowlist');
    await workspace.write('.github/workflows/test.yml', 'name: test');
    return { report: { status: 'completed', summary: 'done' } };
  } });
  assert.equal(result.status, 'completed');
  assert.equal(await readFile(path.join(f.repo, 'src/base.txt'), 'utf8'), 'user changes');
  assert.deepEqual(f.reports[0].report.changedFiles, ['.github/workflows/test.yml', 'other/new.txt']);
});

test('restart recovers a dead worker checkpoint and never executes an orphan again', async t => {
  const f = await fixture(t); const runId = randomUUID(), row = f.rows.get('task0');
  row.state = 'doing'; row.workflow.run = { id: runId }; row.workflow.revision = 3;
  const directory = path.join(f.root, '.s8-runtime/runs', runId), locks = path.join(f.root, '.s8-runtime/development-locks');
  await mkdir(directory, { recursive: true }); await mkdir(locks);
  await writeFile(path.join(locks, 'task0.json'), JSON.stringify({ runId, supervisorPid: 2147483647 }));
  await writeFile(path.join(directory, 'worker-result.json'), JSON.stringify({ status: 'blocked', summary: 'Need decision', verification: [], changedFiles: [], question: { question: 'Which behavior?', reason: 'No requirement', audience: 'human', options: [], impact: '', recommendation: '' } }));
  const recovered = await recoverDevelopmentRuns({ ...f, cleanup: async () => {} });
  assert.equal(recovered[0].status, 'reconciled'); assert.equal(f.reports.length, 1);
  assert.equal(f.rows.get('task0').state, 'blocked');
  assert.equal((await readdir(locks)).length, 0);
  assert.equal(JSON.parse(await readFile(path.join(directory, 'outbox.json'), 'utf8')).delivered, true);
});

test('revoked execution aborts a running worker and preserves the stopped report', async t => {
  const f = await fixture(t)
  const result = await runDevelopmentTask({ ...f, candidate: { uid: 'task0' }, worker: async (_request, { signal }) => {
    f.rows.get('task0').executionAllowed = false
    await new Promise(resolve => signal.addEventListener('abort', resolve, { once: true }))
    return { report: { status: 'completed', summary: 'Must not be accepted as complete', verification: [] } }
  } })
  assert.equal(result.status, 'failed')
  assert.equal(f.rows.get('task0').state, 'blocked')
  assert.equal(f.reports[0].report.question, undefined)
  assert.ok(f.reports[0].report.executionErrors.length)
  assert.match(f.reports[0].report.summary, /Execution stopped/)
})

test('legacy execution budgets and per-repository limits do not restrict the pool', async t => {
  const f = await fixture(t, 2);
  for (const row of f.rows.values()) { row.workflow.runCount = 100; row.workflow.spec.maxRuns = 1; }
  f.policy.perRepoConcurrency = 1;
  let active = 0, max = 0;
  const results = await developmentTick({ ...f, worker: async () => {
    max = Math.max(max, ++active);
    await new Promise(resolve => setTimeout(resolve, 30)); active--;
    return { report: { status: 'completed', summary: 'done' } };
  } });
  assert.equal(results.length, 2);
  assert.equal(max, 2);
  assert.ok([...f.rows.values()].every(row => row.state === 'review'));
});

test('deletion patches preserve protected file and directory checks', async t => {
  const f = await fixture(t)
  const result = await runDevelopmentTask({ ...f, candidate: { uid: 'task0' }, worker: async request => {
    const workspace = developmentWorkspace(request.run.workspace)
    await assert.rejects(workspace.remove('.git'), /Protected/)
    await assert.rejects(workspace.remove('src'), /regular files/)
    await workspace.remove('src/base.txt')
    return { report: { status: 'completed', summary: 'Removed approved obsolete file', verification: [] } }
  } })
  assert.equal(result.status, 'completed')
  assert.deepEqual(f.reports[0].report.changedFiles, ['src/base.txt'])
  const patch = path.join(f.root, '.s8-runtime/runs', result.runId, 'changes.patch')
  await exec('git', ['apply', '--check', patch], { cwd: f.repo })
  assert.equal(await readFile(path.join(f.repo, 'src/base.txt'), 'utf8'), 'base')
})


test('incremental dependency patches compose into a parent integration', async t => {
  const f = await fixture(t, 3);
  const run = async (uid, worker) => runDevelopmentTask({ ...f, candidate: { uid }, worker });
  const first = await run('task0', async request => {
    await developmentWorkspace(request.run.workspace).write('src/shared.txt', 'first\n');
    return { report: { status: 'completed', summary: 'First feature' } };
  });
  assert.equal(first.status, 'completed'); f.rows.get('task0').state = 'done';
  f.rows.get('task1').workflow.spec.dependsOn = ['task0'];
  const second = await run('task1', async request => {
    const workspace = developmentWorkspace(request.run.workspace);
    assert.equal((await workspace.read('src/shared.txt')).content, 'first\n');
    await workspace.write('src/shared.txt', 'first\nsecond\n');
    return { report: { status: 'completed', summary: 'Second feature' } };
  });
  assert.equal(second.status, 'completed'); f.rows.get('task1').state = 'done';
  const parent = f.rows.get('task2'); parent.workflow.spec.dependsOn = ['task0', 'task1'];
  for (const status of ['completed']) {
    const integrated = await run('task2', async request => {
      assert.equal((await developmentWorkspace(request.run.workspace).read('src/shared.txt')).content, 'first\nsecond\n');
      return { report: { status, summary: 'Combined feature verification' } };
    });
    assert.equal(integrated.status, status);
  }
  assert.equal((await exec('git', ['status', '--porcelain'], { cwd: f.repo })).stdout, '');
});

test('failed worker verification is preserved even when no named supervisor checks exist', async t => {
  const f = await fixture(t);
  const result = await runDevelopmentTask({ ...f, candidate: { uid: 'task0' }, worker: async () => ({ report: { status: 'completed', summary: 'Claimed complete', verification: [{ name: 'custom test', ok: false, summary: 'failed' }] } }) });
  assert.equal(result.status, 'failed');
  assert.equal(f.reports[0].report.verification[0].ok, false);
  assert.equal(f.reports[0].report.question, undefined);
});

test('Telegram retry does not repeat the server report or manager receipt', async t => {
  const f = await fixture(t);
  await developmentTick({ ...f, worker: async () => ({ report: { status: 'completed', summary: 'done', verification: [] } }) });
  const [runId] = await readdir(path.join(f.root, '.s8-runtime/runs'));
  const settings = { publicUrl: 'https://s8.example.invalid/s8/', telegram: { scheduleChatId: '123' } };
  let attempts = 0;
  const notify = async message => { attempts++; assert.ok(message.includes(`task=task0&run=${runId}`)); if (attempts === 1) throw new Error('unavailable'); return true; };
  await flushDevelopmentOutbox({ ...f, settings, notify });
  const inbox = path.join(f.root, '.s8-runtime/manager-inbox', `${runId}.json`);
  const received = { ...JSON.parse(await readFile(inbox, 'utf8')), receivedAt: 'fixture' };
  await writeFile(inbox, JSON.stringify(received));
  await Promise.all([flushDevelopmentOutbox({ ...f, settings, notify }), flushDevelopmentOutbox({ ...f, settings, notify })]);
  assert.equal(attempts, 2);
  assert.equal(f.reports.length, 1);
  assert.equal(JSON.parse(await readFile(inbox, 'utf8')).receivedAt, 'fixture');
  const pending = JSON.parse(await readFile(path.join(f.root, '.s8-runtime/runs', runId, 'outbox.json'), 'utf8'));
  assert.equal(pending.telegramDelivered, true);
});

test('lost claim response keeps its original run and is recovered without developer execution', async t => {
  const f = await fixture(t), apply = f.client.workflow;
  let executed = false;
  f.client.workflow = async (uid, operation) => { const result = await apply(uid, operation); if (operation.action === 'claim') throw new Error('response lost'); return result; };
  await runDevelopmentTask({ ...f, candidate: { uid: 'task0' }, workerId: 'worker-1', worker: async () => { executed = true; } });
  assert.equal(executed, false);
  const runId = f.rows.get('task0').workflow.run.id;
  const locks = await readdir(path.join(f.root, '.s8-runtime/development-locks'));
  assert.equal(locks.length, 1);
  await recoverDevelopmentRuns(f);
  assert.equal(f.rows.get('task0').state, 'blocked');
  assert.equal(f.reports[0].runId, runId);
});

test('explicit worker assignments route each UID to the matching idle slot', async t => {
  const f = await fixture(t, 2), assigned = [];
  f.rows.get('task0').workflow.assignment = { assignee: 'worker-2' };
  f.rows.get('task1').workflow.assignment = { assignee: 'worker-1' };
  await developmentTick({ ...f, worker: async request => {
    assigned.push([request.task.uid, request.workerId]);
    return { report: { status: 'completed', summary: 'done', verification: [] } };
  } });
  assert.deepEqual(assigned.sort(), [['task0', 'worker-2'], ['task1', 'worker-1']]);
});

test('historical ready work with a previous run is not automatically executed again', async t => {
  const f = await fixture(t);
  f.rows.get('task0').workflow.run = { id: randomUUID(), status: 'finished' };
  const result = await runDevelopmentTask({ ...f, candidate: { uid: 'task0' }, worker: async () => assert.fail('Must create a new work instead') });
  assert.equal(result.status, 'idle');
  assert.equal(f.reports.length, 0);
});
