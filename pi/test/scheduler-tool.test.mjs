import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import attach from '../extensions/scheduler.ts';

test('scheduler CRUD supports Projectman jobs without scripts, preserves expiry, and requires confirmation', async t => {
  const agent = await mkdtemp(path.join(os.tmpdir(), 's8-scheduler-tool-'));
  t.after(() => rm(agent, { recursive: true, force: true }));
  const previous = process.env.S8_PI_CONFIG_ROOT;
  process.env.S8_PI_CONFIG_ROOT = path.join(agent, 'pi');
  t.after(() => { if (previous === undefined) delete process.env.S8_PI_CONFIG_ROOT; else process.env.S8_PI_CONFIG_ROOT = previous; });
  let tool;
  attach({ registerTool: value => { tool = value; } });
  const execute = (args, confirmation = true) => tool.execute('fixture-call', args, undefined, undefined, { hasUI: true, ui: { confirm: async () => confirmation } });
  await assert.rejects(execute({ action: 'create', id: 'work', kind: 'projectman', projectUid: 'cnt_project' }, false), /Cancelled/);
  await execute({ action: 'create', id: 'work', kind: 'projectman', projectUid: 'cnt_project', expiresAt: '2099-01-01T00:00:00Z' });
  const root = path.join(agent, '.s8-runtime/scheduler');
  let stored = JSON.parse(await readFile(path.join(root, 'jobs.json'), 'utf8')).jobs[0];
  assert.equal(stored.intervalMinutes, 5);
  assert.equal(stored.kind, 'projectman');
  assert.equal(stored.script, undefined);
  await assert.rejects(readFile(path.join(root, 'scripts/work.sh')), { code: 'ENOENT' });
  await execute({ action: 'update', id: 'work', projectUid: 'cnt_other' });
  stored = JSON.parse(await readFile(path.join(root, 'jobs.json'), 'utf8')).jobs[0];
  assert.equal(stored.projectUid, 'cnt_other');
  assert.equal(stored.expiresAt, '2099-01-01T00:00:00Z');
  await execute({ action: 'update', id: 'work', kind: 'shell', script: 'echo approved', intervalMinutes: 5 });
  assert.equal(await readFile(path.join(root, 'scripts/work.sh'), 'utf8'), 'echo approved');
  await execute({ action: 'update', id: 'work', kind: 'projectman', projectUid: 'cnt_project' });
  assert.equal(await readFile(path.join(root, 'scripts/work.sh'), 'utf8'), 'echo approved'); // rollback source retained
  await execute({ action: 'delete', id: 'work' });
  assert.equal(JSON.parse(await readFile(path.join(root, 'jobs.json'), 'utf8')).jobs.length, 0);
  await assert.rejects(readFile(path.join(root, 'scripts/work.sh')), { code: 'ENOENT' });
});
