import test from 'node:test';
import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { mkdtemp, mkdir, writeFile, readFile, rm, realpath } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { startPiServices, supervisorOwner } from '../lib/runtime/services.mjs';
const exec = promisify(execFile);
const quote = value => `'${value.replaceAll("'", "'\\''")}'`;
async function fixture(t) {
  const root = await realpath(await mkdtemp(path.join(os.tmpdir(), "s8-services-'")));
  const socket = `s8-test-${randomUUID()}`;
  const run = args => exec('tmux', ['-L', socket, ...args], { timeout: 5000 });
  t.after(async () => { await run(['kill-server']).catch(() => {}); await rm(root, { recursive: true, force: true }); });
  // Each actual tmux service executes a harmless isolated stub, never real work.
  await writeFile(path.join(root, 's8-config.yml'), 'telegram: {}\nworker-entries:\n  worker-1:\n    agent: pi\n    host: local\n    launch: managed\n  worker-2:\n    agent: pi\n    host: local\n    launch: managed\n');
  await writeFile(path.join(root, 'start-pi.sh'), `#!/bin/sh\ntest "$1" = --service || exit 2\nprintf '%s\\n' "$2" >> ${quote(path.join(root, 'starts'))}\nexec sleep 60\n`);
  await run(['new-session', '-d', '-s', 's8-main', '-n', 'shell', 'sleep 60']);
  await run(['set-option', '-t', 's8-main', '@s8-runtime-root', root]);
  return { root, run };
}

test('default starts both services once and concurrent or later launchers reuse windows in one tmux session', async t => {
  const f = await fixture(t);
  await Promise.all([startPiServices(f.root, { run: f.run }), startPiServices(f.root, { run: f.run })]);
  const later = await startPiServices(f.root, { run: f.run });
  assert.ok(later.filter(item => item.service !== 'workers').every(item => item.reused));
  const starts = (await readFile(path.join(f.root, 'starts'), 'utf8')).trim().split('\n').sort();
  assert.deepEqual(starts, ['scheduler', 'supervisor', 'worker', 'worker']);
  const names = (await f.run(['list-sessions', '-F', '#S'])).stdout;
  assert.ok(names.includes('s8-main')); assert.ok(names.includes('s8-workers-'));
  const windowNames = (await f.run(['list-windows', '-t', 's8-main', '-F', '#W'])).stdout.trim().split('\n').sort();
  assert.deepEqual(windowNames, ['scheduler', 'shell', 'supervisor']);
});

test('each exclusion starts only the requested service; excluding both never invokes tmux', async t => {
  for (const excluded of ['scheduler', 'supervisor']) {
    const f = await fixture(t);
    const results = await startPiServices(f.root, { run: f.run, [excluded]: false });
    assert.equal(results.length, excluded === 'scheduler' ? 2 : 1); assert.notEqual(results[0].service, excluded);
  }
  const f = await fixture(t);
  assert.deepEqual(await startPiServices(f.root, { scheduler: false, supervisor: false, run: () => { throw new Error('Must not start'); } }), []);
});

test('a same-name service from a different checkout is rejected without stopping it', async t => {
  const f = await fixture(t);
  await f.run(['new-window', '-d', '-t', 's8-main:', '-n', 'scheduler', '-c', os.tmpdir(), 'sleep 60']);
  await assert.rejects(startPiServices(f.root, { run: f.run, supervisor: false }), /관리하는 창이 아닙니다/);
  await f.run(['has-session', '-t', '=s8-main']);
});

test('standalone owners and stale locks are not duplicated or silently removed', async t => {
  const f = await fixture(t), directory = path.join(f.root, '.s8-runtime/scheduler');
  await mkdir(directory, { recursive: true }); const file = path.join(directory, 'owner.lock');
  await writeFile(file, `${process.pid}\n`);
  await assert.rejects(startPiServices(f.root, { run: f.run, supervisor: false }), /실행 중/);
  await writeFile(file, '2147483647\n');
  await assert.rejects(startPiServices(f.root, { run: f.run, supervisor: false }), /잠금이 남아/);
  assert.equal(await readFile(file, 'utf8'), '2147483647\n');
});

test('supervisor singleton lock rejects concurrent owners and releases on shutdown', async t => {
  const f = await fixture(t), release = await supervisorOwner(f.root);
  await assert.rejects(supervisorOwner(f.root), { code: 'EEXIST' });
  await release(); const next = await supervisorOwner(f.root); await next();
});


test('another runtime links the same service windows without launching duplicate processes', async t => {
  const f = await fixture(t);
  await startPiServices(f.root, { run: f.run });
  await f.run(['new-session', '-d', '-s', 's8-other', '-n', 'shell', 'sleep 60']);
  await f.run(['set-option', '-t', 's8-other', '@s8-runtime-root', f.root]);
  await startPiServices(f.root, { session: 's8-other', run: f.run });
  for (const service of ['scheduler', 'supervisor']) {
    const id = async session => (await f.run(['display-message', '-p', '-t', `${session}:${service}`, '#{window_id}'])).stdout;
    assert.equal(await id('s8-main'), await id('s8-other'));
  }
  assert.deepEqual((await readFile(path.join(f.root, 'starts'), 'utf8')).trim().split('\n').sort(), ['scheduler', 'supervisor', 'worker', 'worker']);
});

test('restart replaces shared service processes in their existing linked windows', async t => {
  const f = await fixture(t);
  await startPiServices(f.root, { run: f.run });
  const before = (await f.run(['list-windows', '-t', 's8-main', '-F', '#{window_name}\t#{window_id}\t#{pane_pid}'])).stdout.trim().split('\n').map(line => line.split('\t'));
  await startPiServices(f.root, { run: f.run, restart: true });
  const after = (await f.run(['list-windows', '-t', 's8-main', '-F', '#{window_name}\t#{window_id}\t#{pane_pid}'])).stdout.trim().split('\n').map(line => line.split('\t'));
  for (const name of ['scheduler', 'supervisor']) {
    const old = before.find(row => row[0] === name), fresh = after.find(row => row[0] === name);
    assert.equal(fresh[1], old[1]); assert.notEqual(fresh[2], old[2]);
  }
  assert.equal((await readFile(path.join(f.root, 'starts'), 'utf8')).trim().split('\n').length, 6);
});

test('legacy service sessions are linked without restarting their process', async t => {
  const f = await fixture(t);
  await f.run(['new-session', '-d', '-s', 's8-scheduler', '-c', f.root, 'sleep 60']);
  await f.run(['set-option', '-t', 's8-scheduler', '@s8-service-root', f.root]);
  const before = (await f.run(['display-message', '-p', '-t', 's8-scheduler:', '#{pane_pid}'])).stdout;
  await startPiServices(f.root, { run: f.run, supervisor: false });
  assert.equal((await f.run(['display-message', '-p', '-t', 's8-main:scheduler', '#{pane_pid}'])).stdout, before);
  await assert.rejects(readFile(path.join(f.root, 'starts')), { code: 'ENOENT' });
});

test('worker pool uses explicit IDs and canonical checkout identity across launchers', async t => {
  const { ensureWorkerPool } = await import('../lib/development/worker-pool.mjs');
  const f = await fixture(t);
  await writeFile(path.join(f.root, 's8-config.yml'), 'telegram: {}\nworker-entries:\n  local-a:\n    agent: pi\n    host: local\n    launch: managed\n  local-b:\n    agent: pi\n    host: local\n    launch: managed\n  local-c:\n    agent: pi\n    host: local\n    launch: managed\n');
  const first = await ensureWorkerPool(f.root, { run: f.run });
  const second = await ensureWorkerPool(`${f.root}/`, { run: f.run });
  assert.equal(first.session, second.session);
  assert.equal(second.count, 3);
  const names = (await f.run(['list-windows', '-t', first.session, '-F', '#W'])).stdout.trim().split('\n');
  assert.deepEqual(names.filter(name => ['local-a', 'local-b', 'local-c'].includes(name)).sort(), ['local-a', 'local-b', 'local-c']);
  await writeFile(path.join(f.root, 's8-config.yml'), 'telegram: {}\nworker-entries:\n  local-a:\n    agent: pi\n    host: local\n    launch: managed\n  local-b:\n    agent: pi\n    host: local\n    launch: managed\n');
  const deferred = await ensureWorkerPool(f.root, { run: f.run });
  assert.equal(deferred.deferred, true, 'An unreachable worker is never assumed idle for resizing');
  assert.equal(deferred.count, 3);
});
