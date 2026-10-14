import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { isDue, validateJob } from '../lib/scheduler-store.mjs';
import { runScheduler } from '../lib/scheduler-daemon.mjs';
import { controlSchedules } from '../lib/scheduler-control.mjs';

const job = { id: 'morning', time: '09:00', timezone: 'Asia/Seoul', enabled: true, script: 'echo hello' };

test('validates daily jobs and only runs once per local date/time', () => {
  assert.equal(validateJob(job).id, 'morning');
  const due = new Date('2026-02-03T00:00:00Z'); // 09:00 in Seoul
  assert.equal(isDue(job, due, null), true);
  assert.equal(isDue(job, due, '2026-02-03'), false);
  assert.equal(isDue({ ...job, enabled: false }, due, null), false);
  assert.throws(() => validateJob({ ...job, id: '../escape' }), /id/);
  assert.throws(() => validateJob({ ...job, time: '9:00' }), /HH:mm/);
  assert.throws(() => validateJob({ ...job, timezone: 'not-a-timezone' }), /IANA/);
});

test('runs a due script once and persists status without retaining its output', async t => {
  if (process.platform === 'win32') return t.skip('requires Bash; Windows runtime uses Git Bash');
  const temp = await mkdtemp(path.join(os.tmpdir(), 's8-scheduler-'));
  const root = path.join(temp, 'scheduler');
  const scripts = path.join(root, 'scripts');
  await mkdir(scripts, { recursive: true });
  await writeFile(path.join(root, 'jobs.json'), JSON.stringify({ version: 1, jobs: [{ id: job.id, time: job.time, timezone: job.timezone, enabled: true }] }));
  await writeFile(path.join(scripts, 'morning.sh'), 'printf scheduler-check');
  const results = [];
  const options = { root, cwd: temp, env: {}, now: () => new Date('2026-02-03T00:00:00Z'), onResult: value => results.push(value) };
  try {
    let stop = await runScheduler(options);
    await stop();
    const state = JSON.parse(await readFile(path.join(root, 'state.json'), 'utf8'));
    assert.equal(state.jobs.morning.result, 'success');
    assert.match(results[0], /scheduler-check/);
    results.length = 0;
    stop = await runScheduler(options);
    await stop();
    assert.equal(results.length, 0);
    assert.match(await controlSchedules(root), /morning.*success/);
    await controlSchedules(root, 'pause', 'morning');
    assert.equal(JSON.parse(await readFile(path.join(root, 'jobs.json'), 'utf8')).jobs[0].enabled, false);
    await controlSchedules(root, 'resume', 'morning');
    assert.equal(JSON.parse(await readFile(path.join(root, 'jobs.json'), 'utf8')).jobs[0].enabled, true);
    await assert.rejects(controlSchedules(root, 'stop', 'morning'), /실행 중/);
  } finally { await rm(temp, { recursive: true, force: true }); }
});
