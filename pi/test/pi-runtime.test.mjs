import test from 'node:test';
import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { mkdtemp, realpath, mkdir, copyFile, writeFile, readFile, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
const exec = promisify(execFile);
const quote = value => `'${value.replaceAll("'", "'\\''")}'`;

async function fixture(t) {
  const root = await realpath(await mkdtemp(path.join(os.tmpdir(), "s8 runtime-'")));
  const socket = `s8-runtime-${randomUUID()}`;
  const tmux = (await exec('which', ['tmux'])).stdout.trim();
  const run = args => exec(tmux, ['-f', '/dev/null', '-L', socket, ...args], { timeout: 5000 });
  t.after(async () => { await run(['kill-server']).catch(() => {}); await rm(root, { recursive: true, force: true }); });
  for (const directory of ['pi/bin', 'pi/lib', 'pi/node_modules/.bin', 'tools']) await mkdir(path.join(root, directory), { recursive: true });
  await copyFile(new URL('../../start-pi.sh', import.meta.url), path.join(root, 'start-pi.sh'));
  for (const file of ['bin/pi-runtime.mjs', 'bin/manager-options.mjs', 'lib/pi-runtime.mjs', 'lib/pi-services.mjs', 'lib/tmux-windows.mjs', 'lib/managed-sessions.mjs', 'lib/manager-launch.mjs']) {
    await copyFile(new URL(`../${file}`, import.meta.url), path.join(root, 'pi', file));
  }
  for (const service of ['scheduler', 'supervisor']) await writeFile(path.join(root, `pi/bin/${service}.mjs`), `setInterval(() => {}, 1000);`);
  await writeFile(path.join(root, 'tools/tmux'), `#!/bin/sh\nexec ${quote(tmux)} -f /dev/null -L ${quote(socket)} "$@"\n`, { mode: 0o755 });
  await writeFile(path.join(root, 'pi/node_modules/.bin/pi'), `#!/usr/bin/env node
import('node:fs').then(async fs => {
  const {execFileSync} = await import('node:child_process');
  const net = await import('node:net');
  const session = execFileSync('tmux', ['display-message', '-p', '#S'], {encoding:'utf8'}).trim();
  fs.appendFileSync(${JSON.stringify(path.join(root, 'starts'))}, JSON.stringify({session,args:process.argv.slice(2)})+'\\n');
  const socket = process.env.S8_PI_RESTART_DIR + '/' + session + '.sock';
  net.createServer(client => client.once('data', data => {
    fs.appendFileSync(${JSON.stringify(path.join(root, 'telegram'))}, session+'\\n'); client.end('ok');
  })).listen(socket);
});
`, { mode: 0o755 });
  const launch = args => exec('bash', [path.join(root, 'start-pi.sh'), ...args], {
    env: { ...process.env, PATH: `${root}/tools:${process.env.PATH}`, S8_KB_ROOT: root, TMUX: '' }, timeout: 12000,
  });
  return { root, run, launch };
}

test('start-pi returns a detached session with Pi and service windows, reuses it, and hands Telegram to Pi', async t => {
  const f = await fixture(t);
  const result = await f.launch(['--telegram', '--model', 'fixture model']);
  assert.match(result.stdout, /tmux 세션: s8-main/);
  for (const name of ['shell', 'pi', 'scheduler', 'supervisor']) assert.ok(result.stdout.includes(`s8-main:${name}`));
  assert.equal((await f.run(['list-sessions', '-F', '#S'])).stdout.trim(), 's8-main');
  assert.equal((await f.run(['list-clients'])).stdout.trim(), '');
  const record = JSON.parse((await readFile(path.join(f.root, 'starts'), 'utf8')).trim());
  assert.equal(record.session, 's8-main');
  assert.equal(record.args[record.args.indexOf('--model') + 1], 'fixture model');
  assert.equal(record.args[record.args.indexOf('--session-dir') + 1], path.join(f.root, '.pi-runtime/managed/s8-main'));
  assert.ok(record.args.includes(path.join(f.root, 'pi/extensions/managed-session.mjs')));
  await f.launch(['--telegram']);
  assert.equal((await readFile(path.join(f.root, 'starts'), 'utf8')).trim().split('\n').length, 1);
  assert.equal((await readFile(path.join(f.root, 'telegram'), 'utf8')).trim().split('\n').length, 2);
  assert.equal((await f.run(['list-windows', '-t', 's8-main', '-F', '#W'])).stdout.trim().split('\n').length, 4);
  assert.match((await f.launch(['--sessions'])).stdout, /s8-main/);
  await assert.rejects(f.launch(['--model', 'changed model']), /실행 옵션은 변경/);
});

test('named runtime honors exclusions, validates arguments, and never takes over another checkout session', async t => {
  const f = await fixture(t);
  await assert.rejects(f.launch(['--tools', 'bash']), /Unsupported/);
  await assert.rejects(f.launch(['--session', 'bad;name']), /잘못된 세션/);
  await assert.rejects(f.launch(['--session', 'bad\n']), /잘못된 세션/);
  await f.launch(['--session', 'work', '--no-scheduler', '--no-supervisor']);
  assert.deepEqual((await f.run(['list-windows', '-t', 's8-work', '-F', '#W'])).stdout.trim().split('\n').sort(), ['pi', 'shell']);
  await f.run(['new-session', '-d', '-s', 's8-main', 'sleep 60']);
  await assert.rejects(f.launch([]), /이 저장소의 런타임 세션이 아닙니다/);
  await f.run(['has-session', '-t', '=s8-main']);
});

test('concurrent launchers create one runtime and one Pi process', async t => {
  const f = await fixture(t);
  await Promise.all([f.launch([]), f.launch([])]);
  assert.equal((await readFile(path.join(f.root, 'starts'), 'utf8')).trim().split('\n').length, 1);
  assert.equal((await f.run(['list-windows', '-t', 's8-main', '-F', '#W'])).stdout.trim().split('\n').length, 4);
});

test('failed services retain their output and restart in the same window after repair', async t => {
  const f = await fixture(t);
  await writeFile(path.join(f.root, 'pi/bin/scheduler.mjs'), 'console.error("FIXTURE_START_FAILURE"); process.exit(7);');
  await assert.rejects(f.launch([]), /s8-main:scheduler가 시작 직후 종료/);
  const id = (await f.run(['display-message', '-p', '-t', 's8-main:scheduler', '#{window_id}'])).stdout;
  assert.match((await f.run(['capture-pane', '-p', '-S', '-', '-t', 's8-main:scheduler'])).stdout, /FIXTURE_START_FAILURE/);
  await writeFile(path.join(f.root, 'pi/bin/scheduler.mjs'), 'setInterval(() => {}, 1000);');
  await f.launch([]);
  assert.equal((await f.run(['display-message', '-p', '-t', 's8-main:scheduler', '#{window_id}'])).stdout, id);
  await f.launch(['--no-scheduler', '--no-supervisor']);
  assert.equal((await f.run(['list-windows', '-t', 's8-main', '-F', '#W'])).stdout.trim().split('\n').length, 4);
});
