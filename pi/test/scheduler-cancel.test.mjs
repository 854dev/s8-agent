import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { runScheduler } from '../lib/scheduler/daemon.mjs';
import { controlSchedules } from '../lib/scheduler/control.mjs';

test('stop cancels the current shell batch but leaves its schedule enabled', async t => {
  if (process.platform === 'win32') return t.skip('Windows process-tree termination requires Windows');
  const root = await mkdtemp(path.join(os.tmpdir(), 's8-cancel-'));
  let stop;
  try {
    await mkdir(path.join(root, 'scripts'));
    await writeFile(path.join(root, 'jobs.json'), JSON.stringify({ version: 1, jobs: [{ id: 'batch', time: '09:00', timezone: 'Asia/Seoul', enabled: true }] }));
    await writeFile(path.join(root, 'scripts/batch.sh'), 'sleep 60');
    stop = await runScheduler({ root, cwd: root, env: {}, now: () => new Date('2026-02-03T00:00:00Z'), onResult: () => {} });
    const state = async () => JSON.parse(await readFile(path.join(root, 'state.json'), 'utf8')).jobs.batch;
    for (let i = 0; i < 100; i++) {
      if (await state().then(s => s.result === 'running').catch(() => false)) break;
      await new Promise(resolve => setTimeout(resolve, 20));
    }
    assert.match(await controlSchedules(root, 'stop', 'batch'), /中|중단/);
    for (let i = 0; i < 100; i++) {
      if ((await state()).result === 'cancelled') break;
      await new Promise(resolve => setTimeout(resolve, 20));
    }
    assert.equal((await state()).result, 'cancelled');
    assert.equal(JSON.parse(await readFile(path.join(root, 'jobs.json'), 'utf8')).jobs[0].enabled, true);
  } finally {
    if (stop) await stop();
    await rm(root, { recursive: true, force: true });
  }
});
