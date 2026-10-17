import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, writeFile, readFile, readdir, rm } from 'node:fs/promises';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import path from 'node:path';
import os from 'node:os';
import { randomUUID } from 'node:crypto';
import { preflightFingerprint } from '../lib/projectman-preflight.mjs';
import { developmentTick, runDevelopmentTask, flushDevelopmentOutbox, recoverDevelopmentRuns } from '../lib/development-supervisor.mjs';
import { developmentWorkspace, workspaceChanges } from '../lib/development-workspace.mjs';

const exec = promisify(execFile);
async function fixture(t, count = 1) {
  const base = await mkdtemp(path.join(os.tmpdir(), 's8-supervisor-'));
  t.after(() => rm(base, { recursive: true, force: true }));
  const root = path.join(base, 'agent'), repo = path.join(base, 'repo');
  await mkdir(root); await mkdir(repo); await mkdir(path.join(repo, 'src'));
  await writeFile(path.join(repo, 'src/base.txt'), 'base');
  for (const args of [['init'], ['add', '.'], ['-c', 'user.name=Fixture', '-c', 'user.email=fixture@example.invalid', 'commit', '-m', 'fixture']]) await exec('git', args, { cwd: repo });
  const rows = new Map(Array.from({ length: count }, (_, i) => [`task${i}`, { uid: `task${i}`, title: 'Fixture', text: 'Write isolated file', state: 'ready', workflow: { revision: 2, spec: { repoPath: repo, allowedPaths: ['src'], commandNames: [], dependsOn: [], timeBudgetMinutes: 1 }, grant: { specHash: 'fixture' }, specHash: 'fixture' } }]));
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
        row.state = operation.report.status === 'completed' ? 'review' : operation.report.status === 'continue' ? 'ready' : 'blocked'; row.workflow.result = operation.report; reports.push(operation);
      } else if (operation.action === 'request_review') { row.state = 'blocked'; row.workflow.review = { pending: true, ...operation.question }; }
      row.workflow.revision++;
      const response = structuredClone(row); applied.set(operation.requestId, response); return response;
    },
  };
  const policy = { maxConcurrency: 2, perRepoConcurrency: 2, maxTimeMinutes: 1, maxCommandSeconds: 1, commands: {} };
  return { base, root, repo, rows, client, reports, policy };
}

test('two real Git worktrees run concurrently without changing the source repository', async t => {
  const f = await fixture(t, 2); let active = 0, max = 0;
  const worker = async request => {
    assert.match(request.preflight.summary, /Requirements and scope resolved/);
    max = Math.max(max, ++active);
    await developmentWorkspace(request.run.workspace, ['src']).write(`src/${request.task.uid}.txt`, request.task.uid);
    await new Promise(resolve => setTimeout(resolve, 80)); active--;
    return { report: { status: 'completed', summary: 'Changed isolated workspace', verification: [] } };
  };
  const results = await developmentTick({ ...f, allowedRoot: f.base, worker });
  assert.equal(max, 2); assert.equal(results.length, 2); assert.equal(f.reports.length, 2);
  assert.deepEqual([...f.rows.values()].map(row => row.state), ['review', 'review']);
  assert.equal((await exec('git', ['status', '--porcelain'], { cwd: f.repo })).stdout, '');
  assert.equal((await readdir(path.join(f.repo, 'src'))).length, 1);
  for (const result of results) assert.equal((await workspaceChanges(result.worktree, ['src'])).changedFiles.length, 1);
  for (const result of results) await exec('git', ['apply', '--check', path.join(f.root, '.s8-runtime/runs', result.runId, 'changes.patch')], { cwd: f.repo });
});

test('lost report response is replayed from durable outbox without running the developer twice', async t => {
  const f = await fixture(t); const apply = f.client.workflow; let lost = true, executions = 0;
  f.client.workflow = async (uid, operation) => {
    const result = await apply(uid, operation);
    if (operation.action === 'report' && lost) { lost = false; throw new Error('Response lost'); }
    return result;
  };
  await developmentTick({ ...f, allowedRoot: f.base, worker: async () => { executions++; return { report: { status: 'completed', summary: 'done', verification: [] } }; } });
  assert.equal(executions, 1);
  const flushed = await flushDevelopmentOutbox(f);
  assert.equal(flushed[0].delivered, true); assert.equal(f.reports.length, 1);
  await developmentTick({ ...f, allowedRoot: f.base, worker: async () => { throw new Error('Must not rerun'); } });
  assert.equal(executions, 1);
});

test('missing or outdated preflight never starts an approved worker', async t => {
  const f = await fixture(t);
  const row = f.rows.get('task0');
  for (const invalidate of [() => { row.text = 'Changed requirements'; }, () => { delete row.s8Preflight; }]) {
    invalidate();
    const result = await runDevelopmentTask({ ...f, allowedRoot: f.base, candidate: { uid: 'task0' }, worker: async () => { assert.fail('Must not execute before manager review'); } });
    assert.equal(result.status, 'preflight_required');
    assert.equal(row.state, 'ready');
    assert.equal(f.reports.length, 0);
  }
});

test('developer checkpoints continue automatically without creating a decision question', async t => {
  const f = await fixture(t);
  await developmentTick({ ...f, allowedRoot: f.base, worker: async () => ({ report: { status: 'continue', summary: 'Chose existing pattern; continue with validation', question: { question: 'Legacy preference question' } } }) });
  assert.equal(f.rows.get('task0').state, 'ready');
  assert.equal(f.reports[0].report.question, undefined);
  await developmentTick({ ...f, allowedRoot: f.base, worker: async () => ({ report: { status: 'completed', summary: 'Validated existing implementation choice' } }) });
  assert.equal(f.rows.get('task0').state, 'review');
});

test('independent verification failure resumes repair without asking the human or manager', async t => {
  const f = await fixture(t), row = f.rows.get('task0');
  row.workflow.spec.commandNames = ['test'];
  f.policy.commands.test = { argv: ['fixture-test'], network: 'none' };
  row.s8Preflight.fingerprint = preflightFingerprint(await f.client.get('task0'), row.workflow);
  let ok = false;
  const options = { ...f, allowedRoot: f.base, candidate: { uid: 'task0' }, worker: async () => ({ report: { status: 'completed', summary: 'Implementation ready' } }), command: async () => ({ ok, output: ok ? 'passed' : 'assertion failed' }) };
  assert.equal((await runDevelopmentTask(options)).status, 'continue');
  assert.equal(row.state, 'ready');
  assert.equal(f.reports[0].report.question, undefined);
  assert.equal(f.reports[0].report.verification[0].ok, false);
  ok = true;
  assert.equal((await runDevelopmentTask(options)).status, 'completed');
  assert.equal(row.state, 'review');
});

test('unprepared dirty repository becomes a manager operational review instead of silently retrying forever', async t => {
  const f = await fixture(t); await writeFile(path.join(f.repo, 'src/base.txt'), 'user changes');
  const result = await runDevelopmentTask({ ...f, allowedRoot: f.base, candidate: { uid: 'task0' }, worker: async () => { throw new Error('Must not run'); } });
  assert.equal(result.status, 'blocked'); assert.equal(f.rows.get('task0').state, 'blocked');
  assert.equal(f.rows.get('task0').workflow.review.audience, 'manager');
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
  const result = await runDevelopmentTask({ ...f, allowedRoot: f.base, candidate: { uid: 'task0' }, worker: async (_request, { signal }) => {
    f.rows.get('task0').executionAllowed = false
    await new Promise(resolve => signal.addEventListener('abort', resolve, { once: true }))
    return { report: { status: 'completed', summary: 'Must not be accepted as complete', verification: [] } }
  } })
  assert.equal(result.status, 'blocked')
  assert.equal(f.rows.get('task0').state, 'blocked')
  assert.equal(f.reports[0].report.question.audience, 'manager')
  assert.match(f.reports[0].report.summary, /Execution stopped/)
})

test('exhausted run budget asks for manager operational review without invoking a worker', async t => {
  const f = await fixture(t)
  f.rows.get('task0').workflow.runCount = 6
  let invoked = false
  const result = await runDevelopmentTask({ ...f, allowedRoot: f.base, candidate: { uid: 'task0' }, worker: async () => { invoked = true } })
  assert.equal(result.status, 'blocked')
  assert.equal(invoked, false)
  assert.equal(f.rows.get('task0').workflow.review.audience, 'manager')
})

test('per-repository concurrency one serializes otherwise independent tasks', async t => {
  const f = await fixture(t, 2)
  f.policy.perRepoConcurrency = 1
  let active = 0, max = 0
  const results = await developmentTick({ ...f, allowedRoot: f.base, worker: async () => {
    max = Math.max(max, ++active)
    await new Promise(resolve => setTimeout(resolve, 30)); active--
    return { report: { status: 'completed', summary: 'done', verification: [] } }
  } })
  assert.equal(results.length, 2)
  assert.equal(max, 1)
})

test('scoped removal exports an applicable deletion patch and refuses unapproved files and directories', async t => {
  const f = await fixture(t)
  const result = await runDevelopmentTask({ ...f, allowedRoot: f.base, candidate: { uid: 'task0' }, worker: async request => {
    const workspace = developmentWorkspace(request.run.workspace, ['src'])
    await assert.rejects(workspace.remove('.git'), /permissions/)
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
