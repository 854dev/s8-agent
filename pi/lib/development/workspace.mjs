import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { mkdir, readFile, writeFile, lstat, readdir, realpath, unlink, rename } from 'node:fs/promises';
import path from 'node:path';
import { createHash } from 'node:crypto';

const exec = promisify(execFile);
export const safePath = value => typeof value === 'string' && value.length > 0 && !path.isAbsolute(value) && !value.includes('\\') && value.split('/').every(part => part && part !== '..' && part !== '.' && !/secret/i.test(part) && !['.git', '.env', '.pi-runtime', '.s8-runtime', 'auth.json', 'firebase.json', 'node_modules'].includes(part) && (!part.startsWith('.env.') || part === '.env.example')) && !/\.(pem|key)$/i.test(value);
const git = (cwd, args) => exec('git', ['-c', 'core.hooksPath=/dev/null', '-c', 'core.fsmonitor=false', ...args], { cwd, maxBuffer: 1024 * 1024, timeout: 15000 });

export async function prepareWorktree({ root, uid, repoPath }) {
  if (!/^[a-zA-Z0-9_-]{1,120}$/.test(uid)) throw new Error('Invalid task ID');
  const repo = await realpath(repoPath);
  if ((await git(repo, ['rev-parse', '--show-toplevel'])).stdout.trim() !== repo) throw new Error('Repository root required');
  const worktree = path.join(root, '.s8-runtime/worktrees', uid);
  const meta = `${worktree}.json`;
  await mkdir(path.dirname(worktree), { recursive: true, mode: 0o700 });
  try {
    const info = JSON.parse(await readFile(meta, 'utf8'));
    if (info.repo !== repo || (await realpath(worktree)) !== worktree) throw new Error('Worktree identity changed');
    const common = (await git(worktree, ['rev-parse', '--git-common-dir'])).stdout.trim();
    if (await realpath(path.resolve(worktree, common)) !== await realpath(path.join(repo, '.git'))) throw new Error('Worktree repository mismatch');
    return { worktree, ...info };
  } catch (error) { if (error.code !== 'ENOENT') throw error; }
  const baseCommit = (await git(repo, ['rev-parse', 'HEAD'])).stdout.trim();
  const tracked = (await git(repo, ['ls-files', '-z'])).stdout.split('\0').filter(Boolean);
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
  const fingerprints = [];
  for (const file of changedFiles) {
    try { fingerprints.push({ path: file, hash: createHash('sha256').update((await developmentWorkspace(worktree).read(file)).content).digest('hex') }); }
    catch (error) { if (error.code === 'ENOENT') fingerprints.push({ path: file, deleted: true }); else throw error; }
  }
  return { changedFiles, fingerprints };
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

/** Import incremental task patches in dependency order; keep a durable input tree. */
export async function importDevelopmentResults({ root, worktree, tasks }) {
  const manifestPath = path.join(root, '.s8-runtime', 'imports', `${path.basename(worktree)}.json`);
  let manifest = { runs: [], tree: 'HEAD' };
  try { manifest = JSON.parse(await readFile(manifestPath, 'utf8')); } catch (error) { if (error.code !== 'ENOENT') throw error; }
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
