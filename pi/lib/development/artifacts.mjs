import { constants, open, lstat, mkdir, readFile, realpath, writeFile, rename, rm } from 'node:fs/promises';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { git } from './git.mjs';
import { safePath, workspaceTree, applyWorkspacePatch } from './workspace.mjs';
import { saveJson } from '../storage/json-file.mjs';
import { checksum, MAX_BLOB_BYTES, transferBlob } from '../communication/blobs.mjs';

const MARKER = '\nS8_ARTIFACT_V1=';
const SHA = /^[a-f0-9]{40,64}$/;
const RUN = /^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/i;
const readJson = async file => { try { return JSON.parse(await readFile(file, 'utf8')); } catch (error) { if (error.code === 'ENOENT') return null; throw error; } };

export function repositoryFor(config, source) {
  if (!config.enabled) return { path: source, kind: 'git', remote: null };
  const repo = config.repositories?.[source];
  return repo ?? { path: source, kind: 'files', remote: null };
}

export function artifactCheckpoint(checkpoint = '', metadata) {
  if (checkpoint.includes(MARKER)) throw new Error('Checkpoint already contains artifact metadata');
  const value = `${checkpoint}${MARKER}${JSON.stringify(metadata)}`;
  if (value.length > 16000) throw new Error('Artifact metadata and checkpoint exceed the Projectman report limit');
  return value;
}

export function artifactMetadata(task) {
  const report = task.workflow?.result;
  const parts = (report?.checkpoint ?? '').split(MARKER);
  if (parts.length !== 2) throw new Error('Dependency has no unambiguous published artifact metadata');
  let meta;
  try { meta = JSON.parse(parts[1]); } catch { throw new Error('Dependency artifact metadata is invalid'); }
  if (meta.version !== 1 || meta.repo !== task.workflow.spec.repoPath || meta.taskUid !== task.uid || meta.runId !== task.workflow.run?.id || !RUN.test(meta.runId) || !Array.isArray(meta.files) || meta.files.length > 20) throw new Error('Dependency artifact provenance mismatch');
  if (meta.commitSha && (!SHA.test(meta.commitSha) || meta.commitSha !== report.commit || !SHA.test(meta.inputCommit) || !SHA.test(meta.baseCommit) || meta.baseCommit !== report.baseCommit)) throw new Error('Dependency Git artifact identity mismatch');
  if (!['git', 'files'].includes(meta.kind) || (meta.kind === 'git' && !meta.commitSha) || (meta.kind === 'files' && meta.commitSha)) throw new Error('Dependency artifact kind mismatch');
  const names = new Set();
  for (const file of meta.files) {
    if (!safePath(file.name) || names.has(file.name) || !/^[a-f0-9]{64}$/.test(file.sha256) || !Number.isSafeInteger(file.size) || file.size < 0 || file.size > MAX_BLOB_BYTES) throw new Error('Dependency file artifact is invalid');
    names.add(file.name);
  }
  return meta;
}

async function artifactBytes(cwd, name) {
  if (!safePath(name)) throw new Error('Artifact must be a safe relative path');
  const base = await realpath(cwd);
  let cursor = base;
  for (const part of name.split('/')) {
    cursor = path.join(cursor, part);
    const info = await lstat(cursor);
    if (info.isSymbolicLink() || (info.isFile() && info.nlink !== 1)) throw new Error('Artifact links are forbidden');
  }
  const handle = await open(cursor, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
  try {
    const info = await handle.stat();
    if (!info.isFile() || info.size > MAX_BLOB_BYTES) throw new Error('Artifact must be a regular file of at most 8 MiB');
    return await handle.readFile();
  } finally { await handle.close(); }
}

/** Create objects and a run-only ref; never commit on or move the user's branch. */
export async function publishArtifacts({ root, config, claim, task, cwd, files = [], workerId, code = true }) {
  const repo = code ? repositoryFor(config, task.workflow.spec.repoPath) : { kind: 'files' };
  if (!RUN.test(claim.runId)) throw new Error('Invalid artifact run ID');
  const directory = path.join(root, '.s8-runtime/runs', claim.runId);
  await mkdir(directory, { recursive: true, mode: 0o700 });
  const metadataFile = path.join(directory, 'artifact.json');
  let metadata = await readJson(metadataFile);
  const blobs = [];
  if (!Array.isArray(files) || files.length > 20 || new Set(files).size !== files.length) throw new Error('At most 20 distinct artifact paths are allowed');
  for (const name of files) {
    const bytes = await artifactBytes(cwd, name);
    blobs.push({ name, sha256: checksum(bytes), size: bytes.length, bytes });
  }
  const fileRefs = blobs.map(({ bytes, ...ref }) => ref);
  if (metadata && (metadata.kind !== repo.kind || metadata.taskUid !== task.uid || metadata.repo !== task.workflow.spec.repoPath || JSON.stringify(metadata.files) !== JSON.stringify(fileRefs))) throw new Error('Saved artifact identity changed; reconcile the run before reporting');
  if (!metadata) {
    metadata = { version: 1, kind: repo.kind, repo: task.workflow.spec.repoPath, taskUid: task.uid, runId: claim.runId, files: fileRefs };
    if (repo.kind === 'git') {
      try {
        const common = (await git(cwd, ['rev-parse', '--git-common-dir'])).stdout.trim();
        if (await realpath(path.resolve(cwd, common)) !== await realpath(path.join(repo.path, '.git'))) throw new Error();
        const baseCommit = claim.baseCommit ?? (await git(cwd, ['rev-parse', 'HEAD'])).stdout.trim();
        const baseline = claim.inputTree ?? (await git(cwd, ['rev-parse', `${baseCommit}^{tree}`])).stdout.trim();
        const tree = await workspaceTree(cwd, baseline);
        const commit = (tree, parent, title) => git(cwd, ['-c', 'user.name=S8', '-c', 'user.email=s8@localhost', 'commit-tree', tree, '-p', parent, '-m', title]).then(result => result.stdout.trim());
        const inputCommit = await commit(baseline, baseCommit, `S8 input ${claim.runId}`);
        const commitSha = await commit(tree, inputCommit, `S8 result ${claim.uid} ${claim.runId}`);
        Object.assign(metadata, { baseCommit, inputCommit, commitSha });
      } catch { throw new Error('Cannot create Git artifact; check repository mapping, links and protected paths'); }
    }
    // Save identity before publication so a retry uses the same immutable commit.
    await saveJson(metadataFile, metadata);
  }
  if (repo.kind === 'git') {
    try {
      const baseline = (await git(cwd, ['rev-parse', `${metadata.inputCommit}^{tree}`])).stdout.trim();
      const expected = (await git(cwd, ['rev-parse', `${metadata.commitSha}^{tree}`])).stdout.trim();
      if (await workspaceTree(cwd, baseline) !== expected) throw new Error();
      const ref = `refs/heads/s8-runs/${claim.runId}`;
      const existing = (await git(cwd, ['ls-remote', repo.remote, ref])).stdout.trim().split(/\s/)[0];
      if (existing && existing !== metadata.commitSha) throw new Error();
      if (!existing) await git(cwd, ['push', repo.remote, `${metadata.commitSha}:${ref}`]);
    } catch { throw new Error('Git artifact publication failed; check run-ref collision, remote access and push permissions'); }
  }
  for (const blob of blobs) await transferBlob(config, workerId, blob.sha256, { bytes: blob.bytes });
  return metadata;
}

/** Verify only configured remotes and checksummed blobs; never follow metadata-supplied URLs. */
export async function importArtifacts({ root, config, task, worktree, workerId, importCode = true }) {
  if (task.state !== 'done' || task.workflow?.result?.status !== 'completed') throw new Error('Dependency is not completed');
  const meta = artifactMetadata(task), repo = repositoryFor(config, meta.repo);
  if (repo.kind !== meta.kind) throw new Error('Dependency artifact kind does not match this repository mapping');
  const artifacts = [];
  for (const file of meta.files) {
    const bytes = await transferBlob(config, workerId, file.sha256);
    if (bytes.length !== file.size) throw new Error('Dependency artifact size mismatch');
    const destination = path.join(await realpath(root), '.s8-runtime/dependencies', meta.runId, file.name);
    await mkdir(path.dirname(destination), { recursive: true, mode: 0o700 });
    if (await realpath(path.dirname(destination)) !== path.dirname(destination)) throw new Error('Dependency artifact directory contains links');
    const temporary = `${destination}.${randomUUID()}.tmp`;
    try { await writeFile(temporary, bytes, { mode: 0o600, flag: 'wx' }); await rename(temporary, destination); }
    finally { await rm(temporary, { force: true }); }
    artifacts.push({ taskUid: task.uid, runId: meta.runId, name: file.name, path: destination, sha256: file.sha256 });
  }
  if (importCode && meta.kind === 'git') {
    if (repo.kind !== 'git') throw new Error('Git dependency requires a Git repository mapping');
    try {
      await git(worktree, ['fetch', '--no-tags', repo.remote, `refs/heads/s8-runs/${meta.runId}`]);
      const fetched = (await git(worktree, ['rev-parse', 'FETCH_HEAD'])).stdout.trim();
      const parent = (await git(worktree, ['rev-parse', `${meta.commitSha}^`])).stdout.trim();
      const baselineParent = (await git(worktree, ['rev-parse', `${meta.inputCommit}^`])).stdout.trim();
      if (fetched !== meta.commitSha || parent !== meta.inputCommit || baselineParent !== meta.baseCommit) throw new Error();
      const files = (await git(worktree, ['diff', '--name-only', '-z', meta.inputCommit, meta.commitSha])).stdout.split('\0').filter(Boolean);
      if (files.some(file => !safePath(file))) throw new Error();
      const modes = files.length ? (await git(worktree, ['ls-tree', '-r', meta.commitSha, '--', ...files])).stdout : '';
      if (/^(120000|160000) /m.test(modes)) throw new Error();
      const patch = (await git(worktree, ['diff', '--binary', meta.inputCommit, meta.commitSha])).stdout;
      // The caller records successful imports. A conflict must remain an error, not be guessed away.
      await applyWorkspacePatch(worktree, patch);
    } catch { throw new Error('Dependency Git artifact is unavailable, unverified or conflicts with this workspace'); }
  }
  return artifacts;
}
