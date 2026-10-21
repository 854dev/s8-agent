import { mkdir, readFile, writeFile, lstat, readdir, realpath, unlink, rename } from 'node:fs/promises';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { git } from './git.mjs';

export const safePath = value => typeof value === 'string' && value.length > 0 && !path.isAbsolute(value) && !value.includes('\\') && value.split('/').every(part => part && part !== '..' && part !== '.' && !/secret/i.test(part) && !['.git', '.env', '.pi-runtime', '.s8-runtime', 'auth.json', 'firebase.json', 'node_modules'].includes(part) && (!part.startsWith('.env.') || part === '.env.example')) && !/\.(pem|key)$/i.test(value);

/**
 * 실행 위치(repoPath)를 git 저장소로 준비한다. 폴더가 없거나 비어 있으면 만들고 git init 후 빈 첫 커밋을 남긴다.
 * 커밋이 없는 저장소에는 빈 첫 커밋만 만든다(파일은 커밋하지 않는다). 파일이 있는데 git 저장소가 아니면
 * 무엇을 커밋할지(가상환경·빌드 결과·비밀값 등) 사람이 정해야 하므로 거부한다. { repo, initialized }를 돌려준다.
 */
export async function ensureRepository(repoPath) {
  if (typeof repoPath !== 'string' || !path.isAbsolute(repoPath)) throw new Error('Absolute repoPath required');
  await mkdir(repoPath, { recursive: true });
  const repo = await realpath(repoPath);
  const hasGit = await lstat(path.join(repo, '.git')).then(() => true, error => { if (error.code === 'ENOENT') return false; throw error; });
  if (!hasGit) {
    if ((await readdir(repo)).length) throw new Error(`${repo}는 파일이 있는 폴더지만 git 저장소가 아닙니다. 커밋할 파일을 정해 git init과 첫 커밋을 한 뒤 다시 실행하세요.`);
    await git(repo, ['init', '-q']);
  }
  if ((await git(repo, ['rev-parse', '--show-toplevel'])).stdout.trim() !== repo) throw new Error('Repository root required');
  if (await git(repo, ['rev-parse', '--verify', '-q', 'HEAD^{commit}']).then(() => true, () => false)) return { repo, initialized: false };
  const identity = await git(repo, ['config', '--get', 'user.email']).then(() => [], () => ['-c', 'user.name=S8', '-c', 'user.email=s8@localhost']);
  await git(repo, [...identity, 'commit', '-q', '--allow-empty', '--only', '-m', 'S8 첫 커밋']);
  return { repo, initialized: true };
}

export async function prepareWorktree({ root, uid, repoPath, baseCommit: requestedCommit }) {
  if (!/^[a-zA-Z0-9_-]{1,120}$/.test(uid)) throw new Error('Invalid task ID');
  if (requestedCommit !== undefined && !/^[a-f0-9]{40,64}$/.test(requestedCommit)) throw new Error('Invalid approved base commit');
  const { repo } = await ensureRepository(repoPath);
  const worktree = path.join(root, '.s8-runtime/worktrees', uid);
  const meta = `${worktree}.json`;
  await mkdir(path.dirname(worktree), { recursive: true, mode: 0o700 });
  try {
    const info = JSON.parse(await readFile(meta, 'utf8'));
    if (info.repo !== repo || (await realpath(worktree)) !== worktree) throw new Error('Worktree identity changed');
    if (requestedCommit && info.baseCommit !== requestedCommit) throw new Error('Saved worktree has a different approved base commit');
    const common = (await git(worktree, ['rev-parse', '--git-common-dir'])).stdout.trim();
    if (await realpath(path.resolve(worktree, common)) !== await realpath(path.join(repo, '.git'))) throw new Error('Worktree repository mismatch');
    return { worktree, ...info };
  } catch (error) { if (error.code !== 'ENOENT') throw error; }
  const baseCommit = (await git(repo, ['rev-parse', '--verify', `${requestedCommit ?? 'HEAD'}^{commit}`])).stdout.trim();
  await git(repo, ['worktree', 'add', '--detach', worktree, baseCommit]);
  const info = { repo, baseCommit, uid };
  await writeFile(meta, `${JSON.stringify(info)}\n`, { mode: 0o600, flag: 'wx' });
  return { worktree, ...info };
}

export function developmentWorkspace(root) {
  async function resolve(relative, writing) {
    if (!safePath(relative)) throw new Error('Protected or invalid workspace path');
    let cursor = await realpath(root);
    const parts = relative.split('/');
    for (let i = 0; i < parts.length; i++) {
      cursor = path.join(cursor, parts[i]);
      try {
        const stat = await lstat(cursor);
        if (stat.isSymbolicLink() || (stat.isFile() && stat.nlink !== 1)) throw new Error('Workspace links are not allowed');
        if (i < parts.length - 1 ? !stat.isDirectory() : writing && !stat.isFile()) throw new Error('Workspace requires regular files and directories');
      } catch (error) {
        if (error.code !== 'ENOENT' || !writing) throw error;
        if (i < parts.length - 1) await mkdir(cursor);
      }
    }
    return cursor;
  }
  return {
    async read(relative) {
      const file = await resolve(relative, false);
      const stat = await lstat(file);
      if (!stat.isFile() || stat.size > 150_000) throw new Error('Read a regular, smaller file');
      return { path: relative, content: await readFile(file, 'utf8') };
    },
    async list(relative = '') {
      const dir = relative ? await resolve(relative, false) : root;
      return (await readdir(dir, { withFileTypes: true })).filter(entry => !entry.isSymbolicLink() && safePath(relative ? `${relative}/${entry.name}` : entry.name)).slice(0, 200).map(entry => ({ name: entry.name, directory: entry.isDirectory() }));
    },
    async write(relative, content) {
      if (typeof content !== 'string' || Buffer.byteLength(content) > 150_000) throw new Error('Write limit is 150KB');
      await writeFile(await resolve(relative, true), content, { mode: 0o600 });
      return { path: relative, bytes: Buffer.byteLength(content) };
    },
    async remove(relative) {
      if (!safePath(relative)) throw new Error('Protected or invalid workspace path');
      const file = await resolve(relative, false);
      if (!(await lstat(file)).isFile()) throw new Error('Only regular files may be removed');
      await unlink(file);
      return { path: relative, deleted: true };
    },
  };
}

/** 바뀐 파일 목록. 보호 경로(.env·secret·node_modules 등)는 changedFiles·패치에서 빼고 skippedFiles로 돌려준다. */
export async function workspaceChanges(worktree, baseline = 'HEAD') {
  const tracked = (await git(worktree, ['diff', '--name-only', baseline, '-z'])).stdout.split('\0').filter(Boolean);
  const untracked = (await git(worktree, ['ls-files', '--others', '--exclude-standard', '-z'])).stdout.split('\0').filter(Boolean);
  const all = [...new Set([...tracked, ...untracked])];
  return { changedFiles: all.filter(safePath), skippedFiles: all.filter(file => !safePath(file)) };
}

/** Snapshot a private worktree; reset its temporary index to HEAD afterwards. */
export async function workspaceTree(cwd, baseline = 'HEAD') {
  await git(cwd, ['read-tree', baseline]);
  try {
    const { changedFiles, skippedFiles } = await workspaceChanges(cwd, baseline);
    if (skippedFiles.length) throw new Error();
    for (const file of changedFiles) {
      const info = await lstat(path.join(cwd, file)).catch(error => { if (error.code !== 'ENOENT') throw error; return null; });
      if (info?.isSymbolicLink() || (info?.isFile() && info.nlink !== 1)) throw new Error();
    }
    if (changedFiles.length) await git(cwd, ['add', '-A', '--', ...changedFiles]);
    return (await git(cwd, ['write-tree'])).stdout.trim();
  } finally { await git(cwd, ['read-tree', 'HEAD']); }
}

export async function workspacePatch(worktree, baseline = 'HEAD') {
  await git(worktree, ['read-tree', baseline]);
  const { changedFiles } = await workspaceChanges(worktree, baseline);
  if (!changedFiles.length) return '';
  let patch = (await git(worktree, ['diff', '--binary', baseline, '--', ...changedFiles])).stdout;
  const fresh = (await git(worktree, ['ls-files', '--others', '--exclude-standard', '-z'])).stdout.split('\0').filter(Boolean);
  for (const file of fresh.filter(safePath)) {
    try { patch += (await git(worktree, ['diff', '--no-index', '--binary', '--', '/dev/null', file])).stdout; }
    catch (error) { if (error.code !== 1) throw error; patch += error.stdout; }
  }
  return patch;
}

export async function applyWorkspacePatch(worktree, patch, { expectedBaseTree, expectedTree, allowAlreadyApplied = false } = {}) {
  if (typeof patch !== 'string' || Buffer.byteLength(patch) > 64 * 1024 * 1024) throw new Error('Workspace input patch is invalid or too large');
  const temporary = path.join(path.dirname(worktree), `.s8-input-${createHash('sha256').update(`${worktree}:${Date.now()}`).digest('hex').slice(0, 24)}.patch`);
  await writeFile(temporary, patch, { mode: 0o600, flag: 'wx' });
  try {
    const before = await workspaceChanges(worktree);
    if (before.changedFiles.length) await git(worktree, ['add', '--', ...before.changedFiles]);
    const baseTree = (await git(worktree, ['write-tree'])).stdout.trim();
    await git(worktree, ['read-tree', 'HEAD']);
    if (expectedBaseTree && baseTree !== expectedBaseTree) {
      if (allowAlreadyApplied && patch) {
        // Recovery may run after patch application but before the outbox was saved.
        await git(worktree, ['apply', '--reverse', '--check', temporary]);
        return baseTree;
      }
      throw new Error('Worker repository does not match the approved patch baseline');
    }
    if (patch) {
      await git(worktree, ['apply', '--check', temporary]);
      await git(worktree, ['apply', temporary]);
    }
    const { changedFiles } = await workspaceChanges(worktree);
    if (changedFiles.length) await git(worktree, ['add', '--', ...changedFiles]);
    const tree = (await git(worktree, ['write-tree'])).stdout.trim();
    await git(worktree, ['read-tree', 'HEAD']);
    if (expectedTree && tree !== expectedTree) throw new Error('Remote input tree does not match the approved dependency baseline');
    return tree;
  } finally { await unlink(temporary).catch(() => {}); }
}

/** Import incremental task patches in dependency order; keep a durable input tree. */
export async function importDevelopmentResults({ root, worktree, tasks }) {
  const manifestPath = path.join(root, '.s8-runtime', 'imports', `${path.basename(worktree)}.json`);
  let manifest = { runs: [], tree: 'HEAD' };
  try { manifest = JSON.parse(await readFile(manifestPath, 'utf8')); } catch (error) { if (error.code !== 'ENOENT') throw error; }
  if (manifest.tree === 'HEAD') manifest.tree = (await git(worktree, ['write-tree'])).stdout.trim();
  for (const task of tasks) {
    const runId = task.workflow?.run?.id;
    if (!runId || !/^[a-f0-9-]{36}$/.test(runId)) throw new Error('Dependency has no durable run artifact');
    if (manifest.runs.includes(runId)) continue;
    const directory = path.join(root, '.s8-runtime/runs', runId);
    const report = JSON.parse(await readFile(path.join(directory, 'result.json'), 'utf8'));
    if (report.status !== 'completed' || report.changedFiles.some(file => !safePath(file))) throw new Error('Dependency artifact is incomplete or contains protected paths');
    const patch = path.join(directory, 'task.patch');
    if ((await readFile(patch, 'utf8')).length) {
      try { await git(worktree, ['apply', '--check', patch]); await git(worktree, ['apply', patch]); }
      catch {
        try { await git(worktree, ['apply', '--reverse', '--check', patch]); }
        catch { throw new Error('Dependency patch conflicts with the saved workspace'); }
      }
    }
    const changes = await workspaceChanges(worktree);
    if (changes.changedFiles.length) await git(worktree, ['add', '--', ...changes.changedFiles]);
    manifest.tree = (await git(worktree, ['write-tree'])).stdout.trim();
    manifest.runs.push(runId);
    await mkdir(path.dirname(manifestPath), { recursive: true, mode: 0o700 });
    await writeFile(`${manifestPath}.tmp`, JSON.stringify(manifest), { mode: 0o600 });
    await rename(`${manifestPath}.tmp`, manifestPath);
  }
  await git(worktree, ['read-tree', 'HEAD']);
  return manifest.tree;
}
