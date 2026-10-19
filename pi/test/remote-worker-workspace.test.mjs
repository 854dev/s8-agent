import test from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import os from 'node:os';
import { mkdtemp, mkdir, readFile, writeFile, rm, copyFile } from 'node:fs/promises';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { randomUUID } from 'node:crypto';
import { startWorkerCommunicator } from '../lib/development/worker-communicator.mjs';
import { startDeveloperWorker } from '../lib/development/worker-daemon.mjs';
import { developmentWorkspace, prepareWorktree, importDevelopmentResults, applyWorkspacePatch } from '../lib/development/workspace.mjs';
import { runDevelopmentTask, runDeveloper, recoverDevelopmentRuns } from '../lib/development/supervisor.mjs';
import { workerRequest } from '../lib/development/worker-pool.mjs';
import { getWorkerState } from '../lib/development/worker-store.mjs';
import { writeWorkerInputPatch } from '../lib/development/worker-workspace.mjs';
import { preflightFingerprint } from '../lib/projectman/preflight.mjs';

const exec = promisify(execFile);
async function freePort() {
  const net = await import('node:net'), server = net.createServer();
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  const { port } = server.address(); await new Promise(resolve => server.close(resolve)); return port;
}

async function remoteFixture(t, { external = false, executeWork, advanceRemote = false } = {}) {
  const base = await mkdtemp(path.join(os.tmpdir(), 's8-remote-workspace-'));
  t.after(() => rm(base, { recursive: true, force: true }));
  const root = path.join(base, 'manager'), remoteRoot = path.join(base, 'remote-agent'), repo = path.join(base, 'central-repo'), remoteRepo = path.join(base, 'remote-repo');
  await Promise.all([mkdir(root), mkdir(remoteRoot), mkdir(repo)]);
  await writeFile(path.join(repo, 'base.txt'), 'base');
  for (const args of [['init'], ['add', '.'], ['-c', 'user.name=Fixture', '-c', 'user.email=fixture@example.invalid', 'commit', '-m', 'fixture']]) await exec('git', args, { cwd: repo });
  await exec('git', ['clone', '--shared', repo, remoteRepo]);
  if (advanceRemote) {
    await writeFile(path.join(remoteRepo, 'later.txt'), 'A later remote checkout must not change the approved base');
    for (const args of [['add', '.'], ['-c', 'user.name=Fixture', '-c', 'user.email=fixture@example.invalid', 'commit', '-m', 'remote advancement']]) await exec('git', args, { cwd: remoteRepo });
  }
  const workerId = 'remote-pi-1', port = await freePort(), url = `http://127.0.0.1:${port}`;
  const entry = external ? { agent: 'pi', launch: 'external' } : { agent: 'pi', host: 'ssh://worker@remote', launch: 'managed', root: '/remote/s8-agent' };
  const yaml = (withMapping, rootPath) => `telegram: {}\nworker-entries:\n  ${workerId}:\n    agent: pi\n    launch: ${entry.launch}\n${external ? '' : `    host: ssh://worker@remote\n    root: ${rootPath}\n`}worker-communicator:\n  bindAddress: 127.0.0.1\n  port: ${port}\n  url: ${url}\n${withMapping ? `repository-mappings:\n  ${repo}: ${remoteRepo}\n` : ''}`;
  await writeFile(path.join(root, 's8-config.yml'), yaml(false, entry.root));
  await writeFile(path.join(remoteRoot, 's8-config.yml'), yaml(true, remoteRoot));
  const communicator = await startWorkerCommunicator({ root });
  t.after(() => communicator.close());
  const authDirectory = path.join(remoteRoot, '.s8-runtime/worker-auth');
  await mkdir(authDirectory, { recursive: true });
  await copyFile(path.join(root, '.s8-runtime/worker-auth', `${workerId}.token`), path.join(authDirectory, `${workerId}.token`));
  const rows = new Map([['task-remote', { uid: 'task-remote', title: 'Remote fixture', text: 'Write remote.txt', state: 'ready', workflow: {
    version: 2, planVersion: 1, planHash: 'fixture', confirmation: { planVersion: 1, planHash: 'fixture', actorUid: 'human' }, revision: 2,
    spec: { plan: 'Write remote.txt from the mapped clone.', repoPath: repo, commandNames: [], dependsOn: [] }, grant: { specHash: 'fixture' }, specHash: 'fixture',
  } }]]);
  const content = row => ({ uid: row.uid, title: row.title, detail: { text: row.text, attributes: { state: row.state, workflow: row.workflow, s8Preflight: row.s8Preflight } } });
  for (const row of rows.values()) row.s8Preflight = { status: 'reviewed', specHash: row.workflow.specHash, fingerprint: preflightFingerprint(content(row), row.workflow), summary: 'Approved fixture plan.' };
  const client = {
    get: async uid => structuredClone(content(rows.get(uid))),
    getWorkflow: async uid => structuredClone(rows.get(uid)),
    list: async () => [],
    workflow: async (uid, operation) => {
      const row = rows.get(uid);
      if (operation.action === 'claim') { row.state = 'doing'; row.workflow.run = { id: operation.runId, workerId }; }
      else { row.state = operation.report.status === 'completed' ? 'review' : 'blocked'; row.workflow.result = operation.report; }
      row.workflow.revision++;
      return structuredClone(row);
    },
  };
  const worker = await startDeveloperWorker(remoteRoot, workerId, { executeWork: executeWork ?? (async request => {
    assert.equal(request.root, remoteRoot);
    assert.equal(request.run.workspace.startsWith(remoteRoot), true);
    await developmentWorkspace(request.run.workspace).write('remote.txt', 'returned over HTTP');
    const report = { status: 'completed', summary: 'Remote implementation completed.', verification: [{ name: 'fixture', ok: true, summary: 'remote.txt exists' }] };
    await writeFile(path.join(request.run.directory, 'worker-result.json'), JSON.stringify(report));
    return { report };
  }) });
  t.after(() => worker.close());
  for (let index = 0; index < 100; index++) {
    if ((await getWorkerState(root, workerId))?.status === 'idle') break;
    await new Promise(resolve => setTimeout(resolve, 20));
  }
  return { root, remoteRoot, repo, remoteRepo, workerId, entry, rows, client, worker };
}

for (const external of [false, true]) {
  test(`${external ? 'hostless external' : 'managed remote'} worker returns results and Git patches through HTTP`, async t => {
    const { root, repo, workerId, entry, rows, client } = await remoteFixture(t, { external });
    const result = await runDevelopmentTask({ root, client, candidate: { uid: 'task-remote' }, policy: { workerEntries: { [workerId]: entry } }, workerId });
    assert.equal(result.status, 'completed', JSON.stringify({ result, workflow: rows.get('task-remote').workflow }));
    assert.equal(rows.get('task-remote').state, 'review');
    const runDirectory = path.join(root, '.s8-runtime/runs', result.runId);
    assert.equal(JSON.parse(await readFile(path.join(runDirectory, 'worker-result.json'), 'utf8')).summary, 'Remote implementation completed.');
    assert.match(await readFile(path.join(runDirectory, 'task.patch'), 'utf8'), /returned over HTTP/);
    assert.equal(await readFile(path.join(result.worktree, 'remote.txt'), 'utf8'), 'returned over HTTP');
    assert.equal((await exec('git', ['status', '--porcelain'], { cwd: repo })).stdout, '');
  });
}

for (const alreadyApplied of [false, true]) {
  test(`supervisor recovery preserves remote patches (${alreadyApplied ? 'already applied' : 'not yet applied'})`, async t => {
    const f = await remoteFixture(t);
    const uid = 'task-remote', runId = randomUUID();
    const directory = path.join(f.root, '.s8-runtime/runs', runId);
    await mkdir(directory, { recursive: true });
    const task = await f.client.workflow(uid, { action: 'claim', runId });
    const workspace = await prepareWorktree({ root: f.root, uid, repoPath: f.repo });
    const inputTree = await importDevelopmentResults({ root: f.root, worktree: workspace.worktree, tasks: [] });
    const input = await writeWorkerInputPatch(directory, workspace.worktree);
    const request = { root: f.root, workerId: f.workerId, task, baseCommit: workspace.baseCommit, inputTree,
      run: { runId, directory, workspace: workspace.worktree },
      transport: { kind: 'remote', repoPath: f.repo, baseCommit: workspace.baseCommit, inputPatchSha256: input.sha256 },
    };
    await writeFile(path.join(directory, 'request.json'), JSON.stringify(request));
    const locks = path.join(f.root, '.s8-runtime/development-locks');
    await mkdir(locks, { recursive: true });
    await writeFile(path.join(locks, `${uid}.json`), JSON.stringify({ runId, workerId: f.workerId, supervisorPid: 2147483647 }));
    await runDeveloper(request);
    const patch = await readFile(path.join(directory, 'task.patch'), 'utf8');
    const changes = await readFile(path.join(directory, 'changes.patch'), 'utf8');
    if (alreadyApplied) await applyWorkspacePatch(workspace.worktree, patch, { expectedBaseTree: inputTree });
    assert.deepEqual(await recoverDevelopmentRuns(f), [{ runId, status: 'reconciled' }]);
    assert.equal(f.rows.get(uid).state, 'review');
    assert.equal(await readFile(path.join(workspace.worktree, 'remote.txt'), 'utf8'), 'returned over HTTP');
    assert.equal(await readFile(path.join(directory, 'task.patch'), 'utf8'), patch);
    assert.equal(await readFile(path.join(directory, 'changes.patch'), 'utf8'), changes);
    assert.deepEqual(f.rows.get(uid).workflow.result.changedFiles, ['remote.txt']);
    assert.deepEqual(await recoverDevelopmentRuns(f), []);
  });
}


test('remote checkout may advance while the worker still uses the approved base commit', async t => {
  const f = await remoteFixture(t, { advanceRemote: true });
  const remoteHead = (await exec('git', ['rev-parse', 'HEAD'], { cwd: f.remoteRepo })).stdout.trim();
  const result = await runDevelopmentTask({ ...f, worker: runDeveloper, candidate: { uid: 'task-remote' }, policy: { workerEntries: { [f.workerId]: f.entry } } });
  assert.equal(result.status, 'completed');
  assert.notEqual(f.rows.get('task-remote').workflow.result.baseCommit, remoteHead);
  await assert.rejects(readFile(path.join(result.worktree, 'later.txt')), { code: 'ENOENT' });
  assert.equal((await exec('git', ['rev-parse', 'HEAD'], { cwd: f.remoteRepo })).stdout.trim(), remoteHead);
});

test('a permanent export error becomes a failed Projectman result instead of retrying forever', async t => {
  const f = await remoteFixture(t, { executeWork: async request => {
    await writeFile(path.join(request.run.workspace, 'oversize.txt'), 'x'.repeat(150001));
    const report = { status: 'completed', summary: 'fixture', verification: [] };
    await writeFile(path.join(request.run.directory, 'worker-result.json'), JSON.stringify(report));
    return { report };
  } });
  const result = await runDevelopmentTask({ ...f, worker: runDeveloper, candidate: { uid: 'task-remote' }, policy: { workerEntries: { [f.workerId]: f.entry } } });
  assert.equal(result.status, 'failed');
  assert.equal(f.rows.get('task-remote').state, 'blocked');
  assert.equal(f.worker.state().status, 'idle');
  const failure = JSON.parse(await readFile(path.join(f.root, '.s8-runtime/runs', result.runId, 'worker-failure.json'), 'utf8'));
  assert.equal(failure.status, 'failed');
  assert.equal((await readFile(path.join(f.remoteRoot, '.s8-runtime/worktrees/task-remote/oversize.txt'))).length, 150001);
});

test('artifact conflict preserves the uploaded completion record and publishes a separate failure', async t => {
  const f = await remoteFixture(t), fetcher = globalThis.fetch;
  globalThis.fetch = async (url, options) => {
    if (String(url).endsWith('/task.patch') && options?.method === 'PUT') return new Response(JSON.stringify({ error: 'artifact_conflict' }), { status: 409, headers: { 'content-type': 'application/json' } });
    return fetcher(url, options);
  };
  try {
    const result = await runDevelopmentTask({ ...f, worker: runDeveloper, candidate: { uid: 'task-remote' }, policy: { workerEntries: { [f.workerId]: f.entry } } });
    assert.equal(result.status, 'failed');
    const directory = path.join(f.root, '.s8-runtime/runs', result.runId);
    assert.equal(JSON.parse(await readFile(path.join(directory, 'worker-result.json'), 'utf8')).status, 'completed');
    assert.equal(JSON.parse(await readFile(path.join(directory, 'worker-failure.json'), 'utf8')).status, 'failed');
    assert.equal(f.rows.get('task-remote').state, 'blocked');
  } finally { globalThis.fetch = fetcher; }
});

test('an upload connection loss reconnects once and retries immutable artifacts successfully', async t => {
  const f = await remoteFixture(t), fetcher = globalThis.fetch;
  let interrupted = false;
  globalThis.fetch = async (url, options) => {
    if (!interrupted && String(url).endsWith('/task.patch') && options?.method === 'PUT') {
      interrupted = true;
      throw new TypeError('fixture transfer disconnected');
    }
    return fetcher(url, options);
  };
  try {
    const result = await runDevelopmentTask({ ...f, worker: runDeveloper, candidate: { uid: 'task-remote' }, policy: { workerEntries: { [f.workerId]: f.entry } } });
    assert.equal(interrupted, true);
    assert.equal(result.status, 'completed');
    assert.equal(f.rows.get('task-remote').state, 'review');
    assert.equal(f.worker.state().status, 'idle');
    assert.equal(await readFile(path.join(result.worktree, 'remote.txt'), 'utf8'), 'returned over HTTP');
  } finally { globalThis.fetch = fetcher; }
});

test('cancellation interrupts artifact transfer and returns a failed result to Projectman', async t => {
  const f = await remoteFixture(t), fetcher = globalThis.fetch;
  let transferStarted;
  const transferring = new Promise(resolve => { transferStarted = resolve; });
  globalThis.fetch = async (url, options) => {
    if (String(url).endsWith('/task.patch') && options?.method === 'PUT') {
      transferStarted();
      await new Promise((resolve, reject) => {
        const abort = () => reject(new DOMException('fixture transfer canceled', 'AbortError'));
        options.signal.addEventListener('abort', abort, { once: true });
        if (options.signal.aborted) abort();
      });
    }
    return fetcher(url, options);
  };
  try {
    const running = runDevelopmentTask({ ...f, worker: runDeveloper, candidate: { uid: 'task-remote' }, policy: { workerEntries: { [f.workerId]: f.entry } } });
    await transferring;
    const { runId } = await getWorkerState(f.root, f.workerId);
    assert.equal((await workerRequest(f.root, f.workerId, { action: 'cancel', runId })).accepted, true);
    const result = await running;
    assert.equal(result.status, 'failed');
    assert.equal(f.rows.get('task-remote').state, 'blocked');
    assert.match(f.rows.get('task-remote').workflow.result.summary, /canceled/);
    assert.equal(f.worker.state().status, 'idle');
  } finally { globalThis.fetch = fetcher; }
});
