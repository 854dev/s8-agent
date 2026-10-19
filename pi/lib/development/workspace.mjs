import { mkdir, readFile, writeFile, lstat, readdir, realpath, unlink, rename } from 'node:fs/promises';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { git } from './git.mjs';

export const safePath = value => typeof value === 'string' && value.length > 0 && !path.isAbsolute(value) && !value.includes('\\') && value.split('/').every(part => part && part !== '..' && part !== '.' && !/secret/i.test(part) && !['.git', '.env', '.pi-runtime', '.s8-runtime', 'auth.json', 'firebase.json', 'node_modules'].includes(part) && (!part.startsWith('.env.') || part === '.env.example')) && !/\.(pem|key)$/i.test(value);

export async function prepareWorktree({ root, uid, repoPath, baseCommit: requestedCommit }) {
  if (!/^[a-zA-Z0-9_-]{1,120}$/.test(uid)) throw new Error('Invalid task ID');
  if (requestedCommit !== undefined && !/^[a-f0-9]{40,64}$/.test(requestedCommit)) throw new Error('Invalid approved base commit');
  const repo = await realpath(repoPath);
  if ((await git(repo, ['rev-parse', '--show-toplevel'])).stdout.trim() !== repo) throw new Error('Repository root required');
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
  const tracked = (await git(repo, ['ls-tree', '-r', '--name-only', '-z', baseCommit])).stdout.split('\0').filter(Boolean);
  if (tracked.some(file => !safePath(file) && !['AGENTS.md', 'CLAUDE.md', '.gitignore', '.gitattributes'].includes(file) && !file.startsWith('.github/'))) throw new Error('Repository contains protected tracked paths; prepare a clean development repository');
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
    async validate(relative) {
      const stat = await lstat(await resolve(relative, false));
      if (!stat.isFile() || stat.size > 150_000) throw new Error('Read a regular, smaller file');
    },
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

export async function workspaceChanges(worktree) {
  const tracked = (await git(worktree, ['diff', '--name-only', 'HEAD', '-z'])).stdout.split('\0').filter(Boolean);
  const untracked = (await git(worktree, ['ls-files', '--others', '--exclude-standard', '-z'])).stdout.split('\0').filter(Boolean);
  const changedFiles = [...new Set([...tracked, ...untracked])];
  if (changedFiles.some(file => !safePath(file))) throw new Error('Changes contain protected paths');
  const workspace = developmentWorkspace(worktree);
  for (const file of changedFiles) {
    try { await workspace.validate(file); }
    catch (error) { if (error.code !== 'ENOENT') throw error; }
  }
  return { changedFiles };
}

export async function workspacePatch(worktree, baseline = 'HEAD') {
  await git(worktree, ['read-tree', baseline]);
  const { changedFiles } = await workspaceChanges(worktree);
  if (!changedFiles.length) return '';
  let patch = (await git(worktree, ['diff', '--binary', baseline, '--', ...changedFiles])).stdout;
  const fresh = (await git(worktree, ['ls-files', '--others', '--exclude-standard', '-z'])).stdout.split('\0').filter(Boolean);
  for (const file of fresh) {
    if (!safePath(file)) throw new Error('Protected patch path');
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
