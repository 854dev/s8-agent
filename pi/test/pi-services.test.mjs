import test from 'node:test';
import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { mkdtemp, mkdir, writeFile, readFile, rm, realpath } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { startPiServices } from '../lib/runtime/services.mjs';
const exec = promisify(execFile);
const quote = value => `'${value.replaceAll("'", "'\\''")}'`;
async function fixture(t) {
  const root = await realpath(await mkdtemp(path.join(os.tmpdir(), "s8-services-'")));
  const socket = `s8-test-${randomUUID()}`;
  const run = args => exec('tmux', ['-L', socket, ...args], { timeout: 5000 });
  t.after(async () => { await run(['kill-server']).catch(() => {}); await rm(root, { recursive: true, force: true }); });
  // Each actual tmux service executes a harmless isolated stub, never real work.
  await writeFile(path.join(root, 's8-config.yml'), 'telegram: {}\n');
  await writeFile(path.join(root, 's8.sh'), `#!/bin/sh\ntest "$1" = service || exit 2\nprintf '%s\\n' "$2" >> ${quote(path.join(root, 'starts'))}\nexec sleep 60\n`);
  await run(['new-session', '-d', '-s', 's8-main', '-n', 'shell', 'sleep 60']);
  await run(['set-option', '-t', 's8-main', '@s8-runtime-root', root]);
  return { root, run };
}

test('default starts the scheduler as a window of the runtime session; excluding it never invokes tmux', async t => {
  const f = await fixture(t);
  await startPiServices(f.root, { run: f.run });
  assert.equal((await readFile(path.join(f.root, 'starts'), 'utf8')).trim(), 'scheduler');
  const windowNames = (await f.run(['list-windows', '-t', 's8-main', '-F', '#W'])).stdout.trim().split('\n').sort();
  assert.deepEqual(windowNames, ['scheduler', 'shell']);
  assert.deepEqual(await startPiServices(f.root, { scheduler: false, run: () => { throw new Error('Must not start'); } }), []);
});

test('a same-name service from a different checkout is rejected without stopping it', async t => {
  const f = await fixture(t);
  await f.run(['new-window', '-d', '-t', 's8-main:', '-n', 'scheduler', '-c', os.tmpdir(), 'sleep 60']);
  await assert.rejects(startPiServices(f.root, { run: f.run }), /관리하는 창이 아닙니다/);
  await f.run(['has-session', '-t', '=s8-main']);
});

test('a live owner outside tmux is not duplicated; a dead owner lock does not block startup', async t => {
  const f = await fixture(t), directory = path.join(f.root, '.s8-runtime/scheduler');
  await mkdir(directory, { recursive: true }); const file = path.join(directory, 'owner.lock');
  await writeFile(file, `${process.pid}\n`);
  await assert.rejects(startPiServices(f.root, { run: f.run }), /실행 중/);
  await writeFile(file, '2147483647\n');
  await startPiServices(f.root, { run: f.run });
  assert.equal((await readFile(path.join(f.root, 'starts'), 'utf8')).trim(), 'scheduler');
});

test('a second start replaces service processes in their existing windows', async t => {
  const f = await fixture(t);
  await startPiServices(f.root, { run: f.run });
  const before = (await f.run(['list-windows', '-t', 's8-main', '-F', '#{window_name}\t#{window_id}\t#{pane_pid}'])).stdout.trim().split('\n').map(line => line.split('\t'));
  await startPiServices(f.root, { run: f.run });
  const after = (await f.run(['list-windows', '-t', 's8-main', '-F', '#{window_name}\t#{window_id}\t#{pane_pid}'])).stdout.trim().split('\n').map(line => line.split('\t'));
  for (const name of ['scheduler']) {
    const old = before.find(row => row[0] === name), fresh = after.find(row => row[0] === name);
    assert.equal(fresh[1], old[1]); assert.notEqual(fresh[2], old[2]);
  }
  assert.equal((await readFile(path.join(f.root, 'starts'), 'utf8')).trim().split('\n').length, 2);
});
