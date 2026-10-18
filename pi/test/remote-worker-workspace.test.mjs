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
import { developmentWorkspace } from '../lib/development/workspace.mjs';
import { runDevelopmentTask } from '../lib/development/supervisor.mjs';
import { preflightFingerprint } from '../lib/projectman/preflight.mjs';

const exec = promisify(execFile);
async function freePort() {
  const net = await import('node:net'), server = net.createServer();
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  const { port } = server.address(); await new Promise(resolve => server.close(resolve)); return port;
}

test('remote worker receives an approved input patch and returns result and Git patches through the communicator', async t => {
  const base = await mkdtemp(path.join(os.tmpdir(), 's8-remote-workspace-'));
  t.after(() => rm(base, { recursive: true, force: true }));
  const root = path.join(base, 'manager'), remoteRoot = path.join(base, 'remote-agent'), repo = path.join(base, 'central-repo'), remoteRepo = path.join(base, 'remote-repo');
  await Promise.all([mkdir(root), mkdir(remoteRoot), mkdir(repo)]);
  await writeFile(path.join(repo, 'base.txt'), 'base');
  for (const args of [['init'], ['add', '.'], ['-c', 'user.name=Fixture', '-c', 'user.email=fixture@example.invalid', 'commit', '-m', 'fixture']]) await exec('git', args, { cwd: repo });
  await exec('git', ['clone', '--shared', repo, remoteRepo]);
  const workerId = 'remote-pi-1', port = await freePort(), url = `http://127.0.0.1:${port}`;
  const entry = { agent: 'pi', host: 'ssh://worker@remote', launch: 'managed', root: '/remote/s8-agent' };
  const yaml = (withMapping, rootPath) => `telegram: {}\nworker-entries:\n  ${workerId}:\n    agent: pi\n    host: ssh://worker@remote\n    launch: managed\n    root: ${rootPath}\nworker-communicator:\n  bindAddress: 127.0.0.1\n  port: ${port}\n  url: ${url}\n${withMapping ? `repository-mappings:\n  ${repo}: ${remoteRepo}\n` : ''}`;
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
  const worker = await startDeveloperWorker(remoteRoot, workerId, { executeWork: async request => {
    assert.equal(request.root, remoteRoot);
    assert.equal(request.run.workspace.startsWith(remoteRoot), true);
    await developmentWorkspace(request.run.workspace).write('remote.txt', 'returned over HTTP');
    const report = { status: 'completed', summary: 'Remote implementation completed.', verification: [{ name: 'fixture', ok: true, summary: 'remote.txt exists' }] };
    await writeFile(path.join(request.run.directory, 'worker-result.json'), JSON.stringify(report));
    return { report };
  } });
  t.after(() => worker.close());
  for (let index = 0; index < 100; index++) {
    const { getWorkerState } = await import('../lib/development/worker-communicator.mjs');
    if ((await getWorkerState(root, workerId))?.status === 'idle') break;
    await new Promise(resolve => setTimeout(resolve, 20));
  }
  const result = await runDevelopmentTask({ root, client, candidate: { uid: 'task-remote' }, policy: { workerEntries: { [workerId]: entry } }, workerId });
  assert.equal(result.status, 'completed', JSON.stringify({ result, workflow: rows.get('task-remote').workflow }));
  assert.equal(rows.get('task-remote').state, 'review');
  const runDirectory = path.join(root, '.s8-runtime/runs', result.runId);
  assert.equal(JSON.parse(await readFile(path.join(runDirectory, 'worker-result.json'), 'utf8')).summary, 'Remote implementation completed.');
  assert.match(await readFile(path.join(runDirectory, 'task.patch'), 'utf8'), /returned over HTTP/);
  assert.equal(await readFile(path.join(result.worktree, 'remote.txt'), 'utf8'), 'returned over HTTP');
  assert.equal((await exec('git', ['status', '--porcelain'], { cwd: repo })).stdout, '');
});
