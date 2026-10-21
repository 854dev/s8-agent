import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, readFile, writeFile, rm, symlink } from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { randomUUID } from 'node:crypto';
import { git } from '../lib/development/git.mjs';
import { prepareWorktree } from '../lib/development/workspace.mjs';
import { artifactCheckpoint, artifactMetadata, publishArtifacts, importArtifacts } from '../lib/development/artifacts.mjs';
import { reportForServer } from '../lib/development/outbox.mjs';
import { startCommunicationServer } from '../lib/communication/server.mjs';
import { checksum, transferBlob } from '../lib/communication/blobs.mjs';
import { dispatchClaim, readClaim, reportWork } from '../lib/agent/worker-run.mjs';
const DevelopmentReportSchema = await import('../../../ph-cms/packages/server/src/service/usecase/projectman-workflow.schema.ts').then(module => module.DevelopmentReportSchema).catch(() => null);
const parseReport = report => DevelopmentReportSchema ? DevelopmentReportSchema.parse(report) : report;

async function fixture(t) {
  const root = await mkdtemp(path.join(os.tmpdir(), 's8-artifacts-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const seed = path.join(root, 'seed');
  await mkdir(seed);
  await git(seed, ['init', '-q']);
  await writeFile(path.join(seed, 'base.txt'), 'original\n');
  await git(seed, ['add', '.']);
  await git(seed, ['-c', 'user.name=Fixture', '-c', 'user.email=fixture@localhost', 'commit', '-qm', 'base']);
  const remote = path.join(root, 'origin.git');
  await git(root, ['clone', '-q', '--bare', seed, remote]);
  const a = path.join(root, 'a'), b = path.join(root, 'b');
  await git(root, ['clone', '-q', remote, a]);
  await git(root, ['clone', '-q', remote, b]);
  const credentialsFile = path.join(root, 'secrets.json');
  await writeFile(credentialsFile, JSON.stringify({ workers: { a: 'a'.repeat(32), b: 'b'.repeat(32) } }), { mode: 0o600 });
  const store = path.join(root, 'store');
  const server = await startCommunicationServer({ credentialsFile, server: { bindIp: '127.0.0.1', port: 0 } }, { artifactDirectory: store });
  t.after(() => server.close());
  const config = repo => ({ enabled: true, nodeId: 'node', credentialsFile, managerUrl: `ws://127.0.0.1:${server.address.port}`, repositories: { '/approved/repo': { path: repo, kind: 'git', remote: 'origin' } } });
  const rootA = path.join(root, 'runtime-a'), rootB = path.join(root, 'runtime-b');
  const workspaceA = await prepareWorktree({ root: rootA, uid: 'task-a', repoPath: a });
  const workspaceB = await prepareWorktree({ root: rootB, uid: 'task-b', repoPath: b });
  const claim = { uid: 'task-a', runId: randomUUID(), baseCommit: workspaceA.baseCommit, operation: { workerId: 'a' } };
  const task = { uid: claim.uid, workflow: { spec: { repoPath: '/approved/repo' }, run: { id: claim.runId } } };
  return { root, rootA, rootB, a, b, store, remote, configA: config(a), configB: config(b), workspaceA, workspaceB, claim, task };
}

const publishedTask = (f, meta) => ({ ...f.task, state: 'done', workflow: { ...f.task.workflow, result: reportForServer({ status: 'completed', summary: 'Implemented and checked', verification: [{ name: 'check', ok: true }], checkpoint: artifactCheckpoint('', meta), ...(meta.commitSha ? { commit: meta.commitSha, baseCommit: meta.baseCommit } : {}) }) } });

test('separate clones publish immutable run commits and verified files using the actual Projectman schema', async t => {
  const f = await fixture(t);
  const head = (await git(f.a, ['rev-parse', 'HEAD'])).stdout.trim();
  await writeFile(path.join(f.workspaceA.worktree, 'base.txt'), 'updated by A\n');
  await writeFile(path.join(f.workspaceA.worktree, 'evidence.bin'), Buffer.from([0, 1, 2, 255]));
  const meta = await publishArtifacts({ root: f.rootA, config: f.configA, claim: f.claim, task: f.task, cwd: f.workspaceA.worktree, files: ['evidence.bin'], workerId: 'a' });
  assert.equal((await git(f.a, ['rev-parse', 'HEAD'])).stdout.trim(), head);
  assert.equal((await git(f.remote, ['rev-parse', `refs/heads/s8-runs/${f.claim.runId}`])).stdout.trim(), meta.commitSha);
  const task = publishedTask(f, meta);
  if (DevelopmentReportSchema) assert.equal(DevelopmentReportSchema.safeParse(task.workflow.result).success, true);
  const downloaded = await importArtifacts({ root: f.rootB, config: f.configB, task, worktree: f.workspaceB.worktree, workerId: 'b' });
  assert.equal(await readFile(path.join(f.workspaceB.worktree, 'base.txt'), 'utf8'), 'updated by A\n');
  assert.deepEqual(await readFile(downloaded[0].path), Buffer.from([0, 1, 2, 255]));
  assert.equal(downloaded[0].sha256, meta.files[0].sha256);
  const retry = await publishArtifacts({ root: f.rootA, config: f.configA, claim: f.claim, task: f.task, cwd: f.workspaceA.worktree, files: ['evidence.bin'], workerId: 'a' });
  assert.equal(retry.commitSha, meta.commitSha);
  assert.throws(() => artifactMetadata({ ...task, uid: 'another-task' }), /provenance/);
  assert.throws(() => artifactCheckpoint('x'.repeat(16000), meta), /limit/);
});

test('conflicts, moved run refs and unavailable blobs are visible failures', async t => {
  const f = await fixture(t);
  await writeFile(path.join(f.workspaceA.worktree, 'base.txt'), 'A changes\n');
  const meta = await publishArtifacts({ root: f.rootA, config: f.configA, claim: f.claim, task: f.task, cwd: f.workspaceA.worktree, workerId: 'a' });
  const task = publishedTask(f, meta);
  await writeFile(path.join(f.workspaceB.worktree, 'base.txt'), 'B conflicts\n');
  await assert.rejects(importArtifacts({ root: f.rootB, config: f.configB, task, worktree: f.workspaceB.worktree, workerId: 'b' }), /conflicts/);
  assert.equal(await readFile(path.join(f.workspaceB.worktree, 'base.txt'), 'utf8'), 'B conflicts\n');
  await git(f.remote, ['update-ref', `refs/heads/s8-runs/${f.claim.runId}`, f.workspaceA.baseCommit]);
  await assert.rejects(importArtifacts({ root: f.rootB, config: f.configB, task, worktree: f.workspaceB.worktree, workerId: 'b' }), /unverified/);
  await assert.rejects(transferBlob(f.configB, 'b', '0'.repeat(64)), /transfer failed/);
});

test('report-only outputs use checksums without Git; protected files, links and bad hashes are rejected', async t => {
  const f = await fixture(t);
  const config = { ...f.configA, repositories: { '/approved/repo': { path: f.root, kind: 'files', remote: null } } };
  await writeFile(path.join(f.root, 'report.txt'), 'Research evidence');
  const meta = await publishArtifacts({ root: f.rootA, config, claim: f.claim, task: f.task, cwd: f.root, files: ['report.txt'], workerId: 'a' });
  assert.equal(meta.commitSha, undefined);
  const task = publishedTask(f, meta);
  if (DevelopmentReportSchema) assert.equal(DevelopmentReportSchema.safeParse(task.workflow.result).success, true);
  const files = await importArtifacts({ root: f.rootB, config: { ...f.configB, repositories: config.repositories }, task, workerId: 'b', importCode: false });
  assert.equal(await readFile(files[0].path, 'utf8'), 'Research evidence');
  await assert.rejects(publishArtifacts({ root: f.rootA, config, claim: f.claim, task: f.task, cwd: f.root, files: ['.env'], workerId: 'a' }), /safe relative/);
  await symlink(path.join(f.root, 'report.txt'), path.join(f.root, 'link.txt'));
  await assert.rejects(publishArtifacts({ root: f.rootA, config, claim: f.claim, task: f.task, cwd: f.root, files: ['link.txt'], workerId: 'a' }), /links/);
  await assert.rejects(transferBlob(f.configA, 'a', checksum(Buffer.from('expected')), { bytes: Buffer.from('wrong') }), /transfer failed/);
});

test('report does not require Git publication or a reachable remote', async t => {
  const f = await fixture(t);
  await writeFile(path.join(f.rootA, 's8-config.yml'), `communication:\n  enabled: true\n  nodeId: node\n  credentialsFile: ${f.configA.credentialsFile}\n  managerUrl: ${f.configA.managerUrl}\n  repositories:\n    /approved/repo:\n      path: ${f.a}\n      remote: origin\n`);
  await dispatchClaim(f.rootA, { uid: f.claim.uid, operation: { action: 'claim', requestId: randomUUID(), runId: f.claim.runId, workerId: 'a', expectedRevision: 1 }, baseCommit: f.claim.baseCommit });
  const claim = { ...await readClaim(f.rootA, f.claim.uid), revision: 2 };
  await git(f.a, ['remote', 'set-url', 'origin', path.join(f.root, 'missing.git')]);
  let report;
  const client = { getWorkflow: async () => f.task, workflow: async (_uid, operation) => { report = parseReport(operation.report); return { state: 'blocked' }; } };
  const result = await reportWork({ root: f.rootA, client, claim, cwd: f.workspaceA.worktree, result: { status: 'completed', summary: 'Done', verification: [] } });
  assert.equal(result.status, 'completed');
  assert.equal(report.status, 'completed');
  assert.deepEqual(report.executionErrors, []);
  assert.equal(report.commit, undefined);
});

test('real Projectman schema accepts versioned artifact metadata without new report fields', { skip: DevelopmentReportSchema ? false : 'Sibling PH-CMS schema unavailable' }, () => {
  const report = reportForServer({ status: 'completed', summary: 'Checked', commit: 'a'.repeat(40), baseCommit: 'b'.repeat(40), checkpoint: artifactCheckpoint('', { version: 1, files: [] }) });
  assert.equal(DevelopmentReportSchema.parse(report).commit, report.commit);
});

test('optional file upload failure preserves the reported implementation result', async t => {
  const f = await fixture(t);
  await writeFile(path.join(f.rootA, 's8-config.yml'), `communication:\n  enabled: true\n  nodeId: node\n  credentialsFile: ${f.configA.credentialsFile}\n  managerUrl: ${f.configA.managerUrl}\n`);
  let report;
  const client = { getWorkflow: async () => f.task, workflow: async (_uid, operation) => { report = operation.report; return { state: 'review' }; } };
  const claim = { ...f.claim, operation: { workerId: 'a' }, revision: 2 };
  const result = await reportWork({ root: f.rootA, client, claim, cwd: f.rootA, result: { status: 'completed', summary: 'Done', artifacts: ['missing-output.txt'] } });
  assert.equal(result.status, 'completed');
  assert.match(report.decisions[0], /산출물 전달 실패/);
  parseReport(report);
});

test('Git artifact captures a task reverting a dependency to the original base and rejects changed retry content', async t => {
  const f = await fixture(t);
  await writeFile(path.join(f.workspaceA.worktree, 'base.txt'), 'dependency input\n');
  await git(f.workspaceA.worktree, ['add', 'base.txt']);
  const inputTree = (await git(f.workspaceA.worktree, ['write-tree'])).stdout.trim();
  await git(f.workspaceA.worktree, ['read-tree', 'HEAD']);
  await writeFile(path.join(f.workspaceA.worktree, 'base.txt'), 'original\n');
  const claim = { ...f.claim, inputTree };
  const meta = await publishArtifacts({ root: f.rootA, config: f.configA, claim, task: f.task, cwd: f.workspaceA.worktree, workerId: 'a' });
  assert.equal((await git(f.a, ['show', `${meta.commitSha}:base.txt`])).stdout, 'original\n');
  assert.equal((await git(f.a, ['show', `${meta.inputCommit}:base.txt`])).stdout, 'dependency input\n');
  await writeFile(path.join(f.workspaceA.worktree, 'base.txt'), 'changed after snapshot\n');
  await assert.rejects(publishArtifacts({ root: f.rootA, config: f.configA, claim, task: f.task, cwd: f.workspaceA.worktree, workerId: 'a' }), /publication failed/);
});
