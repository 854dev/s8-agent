import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { mkdir, readFile, writeFile, lstat, readdir, realpath, unlink } from 'node:fs/promises';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { boundedCommand, SMOKE_IMAGE } from './development-smoke.mjs';

const exec = promisify(execFile);
export const safePath = value => typeof value === 'string' && value.length > 0 && !path.isAbsolute(value) && !value.includes('\\') && value.split('/').every(part => part && part !== '..' && !/secret/i.test(part) && (!part.startsWith('.') || ['.env.example', '.gitignore'].includes(part)) && !['auth.json', 'firebase.json', 'AGENTS.md', 'CLAUDE.md', 'node_modules'].includes(part)) && !/\.(pem|key)$/i.test(value);
export const permittedWrite = (value, allowed) => safePath(value) && allowed.some(prefix => value === prefix || value.startsWith(`${prefix}/`));
const git = (cwd, args) => exec('git', ['-c', 'core.hooksPath=/dev/null', '-c', 'core.fsmonitor=false', ...args], { cwd, maxBuffer: 1024 * 1024, timeout: 15000 });

export async function prepareWorktree({ root, uid, repoPath, allowedRoot = path.dirname(root) }) {
  if (!/^[a-zA-Z0-9_-]{1,120}$/.test(uid)) throw new Error('Invalid task ID');
  const repo = await realpath(repoPath), scope = await realpath(allowedRoot);
  const relative = path.relative(scope, repo);
  if (!relative || relative.startsWith('..') || path.isAbsolute(relative) || relative.split(path.sep).some(part => part.startsWith('.') || /secret/i.test(part))) throw new Error('Repository outside configured development root');
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
  if ((await git(repo, ['status', '--porcelain'])).stdout.trim()) throw new Error('Base repository has uncommitted changes');
  const baseCommit = (await git(repo, ['rev-parse', 'HEAD'])).stdout.trim();
  const tracked = (await git(repo, ['ls-files', '-z'])).stdout.split('\0').filter(Boolean);
  if (tracked.some(file => !safePath(file) && !['AGENTS.md', 'CLAUDE.md', '.gitignore', '.gitattributes'].includes(file) && !file.startsWith('.github/'))) throw new Error('Repository contains protected tracked paths; prepare a clean development repository');
  await git(repo, ['worktree', 'add', '--detach', worktree, baseCommit]);
  const info = { repo, baseCommit, uid };
  await writeFile(meta, `${JSON.stringify(info)}\n`, { mode: 0o600, flag: 'wx' });
  return { worktree, ...info };
}

export function developmentWorkspace(root, allowedPaths) {
  async function resolve(relative, writing) {
    if (!safePath(relative) || (writing && !permittedWrite(relative, allowedPaths))) throw new Error('Path outside development permissions');
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
      if (!permittedWrite(relative, allowedPaths)) throw new Error('Path outside development permissions');
      const file = await resolve(relative, false);
      if (!(await lstat(file)).isFile()) throw new Error('Only regular files may be removed');
      await unlink(file);
      return { path: relative, deleted: true };
    },
  };
}

export async function workspaceChanges(worktree, allowedPaths) {
  const tracked = (await git(worktree, ['diff', '--name-only', 'HEAD', '-z'])).stdout.split('\0').filter(Boolean);
  const untracked = (await git(worktree, ['ls-files', '--others', '--exclude-standard', '-z'])).stdout.split('\0').filter(Boolean);
  const changedFiles = [...new Set([...tracked, ...untracked])];
  if (changedFiles.some(file => !permittedWrite(file, allowedPaths))) throw new Error('Changes exceeded approved paths');
  const fingerprints = [];
  for (const file of changedFiles) {
    try { fingerprints.push({ path: file, hash: createHash('sha256').update((await developmentWorkspace(worktree, allowedPaths).read(file)).content).digest('hex') }); }
    catch (error) { if (error.code === 'ENOENT') fingerprints.push({ path: file, deleted: true }); else throw error; }
  }
  return { changedFiles, fingerprints };
}

export async function workspacePatch(worktree, allowedPaths) {
  const { changedFiles } = await workspaceChanges(worktree, allowedPaths);
  if (!changedFiles.length) return '';
  let patch = (await git(worktree, ['diff', '--binary', 'HEAD', '--', ...changedFiles])).stdout;
  const fresh = (await git(worktree, ['ls-files', '--others', '--exclude-standard', '-z'])).stdout.split('\0').filter(Boolean);
  for (const file of fresh) {
    if (!permittedWrite(file, allowedPaths)) throw new Error('Unapproved patch path');
    try { patch += (await git(worktree, ['diff', '--no-index', '--binary', '--', '/dev/null', file])).stdout; }
    catch (error) { if (error.code !== 1) throw error; patch += error.stdout; }
  }
  return patch;
}

export async function developmentCommand({ root, worktree, name, allowedNames, policy, runId, signal }) {
  if (!allowedNames.includes(name) || !Object.hasOwn(policy.commands, name)) throw new Error('Command was not authorized');
  const command = policy.commands[name];
  const containerName = `s8-dev-${runId}`;
  const args = ['run', '--rm', '--init', '--name', containerName, '--user', `${process.getuid()}:${process.getgid()}`, '--cap-drop', 'ALL', '--security-opt', 'no-new-privileges', '--pids-limit', '128', '--cpus', '2', '--memory', '2g', '--read-only', '--tmpfs', '/tmp:rw,nosuid,size=512m', '--network', command.network, '--mount', `type=bind,source=${worktree},target=/work`, '--workdir', '/work', '--env', 'npm_config_cache=/tmp/npm-cache', command.image ?? policy.image ?? SMOKE_IMAGE, ...command.argv];
  try { return await boundedCommand('docker', args, { cwd: root, signal, timeoutMs: policy.maxCommandSeconds * 1000 }); }
  finally { await boundedCommand('docker', ['rm', '-f', containerName], { timeoutMs: 10000 }); }
}
