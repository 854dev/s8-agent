import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, realpath, rm, stat, writeFile } from 'node:fs/promises';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import path from 'node:path';
import os from 'node:os';
import { ensureRepository, prepareWorktree } from '../lib/development/workspace.mjs';

const exec = promisify(execFile);
const git = async (cwd, ...args) => (await exec('git', args, { cwd })).stdout.trim();

async function fixture(t) {
  const base = await realpath(await mkdtemp(path.join(os.tmpdir(), 's8-repo-')));
  t.after(() => rm(base, { recursive: true, force: true }));
  return base;
}

test('a missing repoPath is created as a git repository with an initial commit', async t => {
  const base = await fixture(t);
  const repoPath = path.join(base, 'new/app');
  assert.deepEqual(await ensureRepository(repoPath), { repo: repoPath, initialized: true });
  assert.equal(await git(repoPath, 'rev-list', '--count', 'HEAD'), '1');
  assert.deepEqual(await ensureRepository(repoPath), { repo: repoPath, initialized: false });
  assert.equal(await git(repoPath, 'rev-list', '--count', 'HEAD'), '1');
  const root = path.join(base, 'agent');
  const { worktree, repo } = await prepareWorktree({ root, uid: 'task1', repoPath: path.join(base, 'other') });
  assert.equal(repo, path.join(base, 'other'));
  assert.equal(await git(worktree, 'rev-parse', 'HEAD'), await git(repo, 'rev-parse', 'HEAD'));
});

test('an existing folder with files that is not a git repository is refused untouched', async t => {
  const base = await fixture(t);
  await mkdir(path.join(base, '.venv'));
  await writeFile(path.join(base, 'main.py'), 'print(1)');
  await assert.rejects(ensureRepository(base), /git 저장소가 아닙니다/);
  await assert.rejects(stat(path.join(base, '.git')), { code: 'ENOENT' });
  const empty = path.join(base, 'empty');
  await mkdir(empty);
  assert.equal((await ensureRepository(empty)).initialized, true);
});

test('a repository without commits gets an empty first commit; one with commits is left alone', async t => {
  const base = await fixture(t);
  const empty = path.join(base, 'empty'), used = path.join(base, 'used');
  for (const dir of [empty, used]) { await mkdir(dir); await git(dir, 'init', '-q'); }
  await writeFile(path.join(empty, 'README.md'), 'hi');
  await writeFile(path.join(empty, 'staged.txt'), 'staged');
  await git(empty, 'add', 'staged.txt');
  assert.equal((await ensureRepository(empty)).initialized, true);
  assert.equal(await git(empty, 'ls-tree', '-r', '--name-only', 'HEAD'), '');
  assert.equal(await git(empty, 'status', '--porcelain'), 'A  staged.txt\n?? README.md');
  await git(used, '-c', 'user.name=t', '-c', 'user.email=t@t', 'commit', '-q', '--allow-empty', '-m', 'base');
  await writeFile(path.join(used, 'draft.txt'), 'uncommitted');
  const head = await git(used, 'rev-parse', 'HEAD');
  assert.equal((await ensureRepository(used)).initialized, false);
  assert.equal(await git(used, 'rev-parse', 'HEAD'), head);
  assert.equal(await git(used, 'status', '--porcelain'), '?? draft.txt');
});
