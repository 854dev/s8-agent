import { createHash } from 'node:crypto';
import path from 'node:path';
import { mkdir, readFile, realpath, writeFile } from 'node:fs/promises';
import { loadS8Config } from '../config/s8-config.mjs';
import { applyWorkspacePatch, prepareWorktree, workspaceChanges, workspacePatch } from './workspace.mjs';
import { downloadWorkerArtifact, uploadWorkerArtifact } from './worker-communicator.mjs';

const exec = async (cwd, args) => {
  const { execFile } = await import('node:child_process');
  const { promisify } = await import('node:util');
  return promisify(execFile)('git', ['-c', 'core.hooksPath=/dev/null', '-c', 'core.fsmonitor=false', ...args], { cwd, maxBuffer: 1024 * 1024, timeout: 15000 });
};

export async function prepareWorkerWorkspace(root, workerId, connectionId, request) {
  if (request.transport?.kind !== 'remote') return request;
  const repoPath = loadS8Config(root).repositoryMappings[request.transport.repoPath];
  if (!repoPath) throw new Error('This worker has no local repository mapping for the approved repository');
  const repo = await realpath(repoPath);
  const workspace = await prepareWorktree({ root, uid: request.task.uid, repoPath: repo });
  if (workspace.baseCommit !== request.transport.baseCommit) throw new Error('Remote repository does not have the approved base commit checked out');
  const downloaded = await downloadWorkerArtifact(root, workerId, connectionId, request.run.runId, 'input.patch');
  if (downloaded.sha256 !== request.transport.inputPatchSha256) throw new Error('Approved dependency patch hash does not match');
  const directory = path.join(root, '.s8-runtime/runs', request.run.runId);
  await mkdir(directory, { recursive: true, mode: 0o700 });
  await writeFile(path.join(directory, 'input.patch'), downloaded.bytes, { mode: 0o600 });
  const baseTree = (await exec(workspace.worktree, ['rev-parse', `${workspace.baseCommit}^{tree}`])).stdout.trim();
  const inputTree = await applyWorkspacePatch(workspace.worktree, downloaded.bytes.toString('utf8'), { expectedBaseTree: baseTree, expectedTree: request.inputTree });
  return {
    ...request,
    root,
    run: { ...request.run, directory, workspace: workspace.worktree },
    baseCommit: workspace.baseCommit,
    inputTree,
  };
}

export async function uploadWorkerResults(root, workerId, connectionId, originalRequest, executionRequest, result) {
  if (originalRequest.transport?.kind !== 'remote') return;
  const runId = originalRequest.run.runId;
  const directory = executionRequest.run?.directory ?? path.join(root, '.s8-runtime/runs', runId);
  await mkdir(directory, { recursive: true, mode: 0o700 });
  const resultFile = path.join(directory, 'worker-result.json');
  let report;
  try { report = JSON.parse(await readFile(resultFile, 'utf8')); }
  catch (error) { if (error.code !== 'ENOENT') throw error; }
  if (!report && result?.report) {
    report = result.report;
    await writeFile(resultFile, `${JSON.stringify(report)}\n`, { mode: 0o600 });
  }
  if (!report) {
    report = { status: 'failed', summary: 'Worker ended without a result report.', executionErrors: ['No worker result was returned'], verification: [], changedFiles: [] };
    await writeFile(resultFile, `${JSON.stringify(report)}\n`, { mode: 0o600 });
  }
  const artifacts = new Map([['worker-result.json', await readFile(resultFile)]]);
  let workspace = executionRequest.run?.workspace;
  if (workspace) {
    const changes = await workspaceChanges(workspace);
    const taskPatch = await workspacePatch(workspace, executionRequest.inputTree);
    const changesPatch = await workspacePatch(workspace);
    artifacts.set('task.patch', Buffer.from(taskPatch));
    artifacts.set('changes.patch', Buffer.from(changesPatch));
    if (report.status === 'completed') {
      report = { ...report, changedFiles: changes.changedFiles, baseCommit: executionRequest.baseCommit };
      await writeFile(resultFile, `${JSON.stringify(report)}\n`, { mode: 0o600 });
      artifacts.set('worker-result.json', await readFile(resultFile));
    }
  }
  try { artifacts.set('developer.events.jsonl', await readFile(path.join(directory, 'developer.events.jsonl'))); }
  catch (error) { if (error.code !== 'ENOENT') throw error; artifacts.set('developer.events.jsonl', Buffer.alloc(0)); }
  for (const [name, bytes] of artifacts) await uploadWorkerArtifact(root, workerId, connectionId, runId, name, bytes);
}

export async function writeWorkerInputPatch(directory, worktree, inputTree) {
  const patch = await workspacePatch(worktree);
  const baseTree = (await exec(worktree, ['rev-parse', 'HEAD^{tree}'])).stdout.trim();
  const file = path.join(directory, 'input.patch');
  await writeFile(file, patch, { mode: 0o600 });
  return { patch, file, sha256: createHash('sha256').update(patch).digest('hex'), inputTree, baseTree };
}
