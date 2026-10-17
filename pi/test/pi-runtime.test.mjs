import test from 'node:test';
import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { mkdtemp, realpath, mkdir, copyFile, writeFile, readFile, readdir, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import net from 'node:net';
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
  for (const file of ['bin/pi-runtime.mjs', 'bin/pi-runtime-worker.mjs', 'bin/manager-options.mjs', 'lib/pi-runtime-restart.mjs', 'lib/full-restart.mjs', 'lib/pi-runtime.mjs', 'lib/pi-services.mjs', 'lib/tmux-windows.mjs', 'lib/managed-sessions.mjs', 'lib/manager-launch.mjs']) {
    await copyFile(new URL(`../${file}`, import.meta.url), path.join(root, 'pi', file));
  }
  for (const service of ['scheduler', 'supervisor']) await writeFile(path.join(root, `pi/bin/${service}.mjs`), `import {appendFileSync} from 'node:fs'; appendFileSync(${JSON.stringify(path.join(root, 'service-starts'))}, JSON.stringify({service:${JSON.stringify(service)},pid:process.pid})+'\\n'); setInterval(() => {}, 1000);`);
  await writeFile(path.join(root, 'tools/tmux'), `#!/bin/sh\nexec ${quote(tmux)} -f /dev/null -L ${quote(socket)} "$@"\n`, { mode: 0o755 });
  await writeFile(path.join(root, 'pi/node_modules/.bin/pi'), `#!/usr/bin/env node
import('node:fs').then(async fs => {
  const {execFileSync, spawn} = await import('node:child_process');
  const net = await import('node:net');
  const session = execFileSync('tmux', ['display-message', '-p', '#S'], {encoding:'utf8'}).trim();
  fs.appendFileSync(${JSON.stringify(path.join(root, 'starts'))}, JSON.stringify({session,args:process.argv.slice(2)})+'\\n');
  if (!process.argv.some(arg => arg.endsWith('/extensions/managed-session.mjs'))) { setInterval(() => {}, 1000); return; }
  const socket = process.env.S8_PI_RESTART_DIR + '/' + session + '.sock';
  if (fs.existsSync(socket)) fs.unlinkSync(socket);
  net.createServer(client => client.once('data', data => {
    if (data.toString() === 'self-restart') {
      spawn('bash', [${JSON.stringify(path.join(root, 'start-pi.sh'))}, '--no-telegram'], {stdio:'ignore'});
      client.end('ok'); return;
    }
    fs.appendFileSync(${JSON.stringify(path.join(root, 'telegram'))}, session+'\\n'); client.end('ok');
  })).listen(socket);
});
`, { mode: 0o755 });
  const launch = args => exec('bash', [path.join(root, 'start-pi.sh'), ...args], {
    env: { ...process.env, PATH: `${root}/tools:${process.env.PATH}`, S8_KB_ROOT: root, TMUX: '' }, timeout: 12000,
  });
  return { root, run, launch };
}

test('start-pi fully restarts Pi and both services, resumes the session and connects Telegram by default', async t => {
  const f = await fixture(t);
  const result = await f.launch(['--model', 'fixture model']);
  assert.match(result.stdout, /tmux 세션: s8-main/);
  for (const name of ['shell', 'pi', 'scheduler', 'supervisor']) assert.ok(result.stdout.includes(`s8-main:${name}`));
  assert.equal((await f.run(['list-sessions', '-F', '#S'])).stdout.trim(), 's8-main');
  assert.equal((await f.run(['list-clients'])).stdout.trim(), '');
  const record = JSON.parse((await readFile(path.join(f.root, 'starts'), 'utf8')).trim());
  assert.equal(record.session, 's8-main');
  assert.equal(record.args[record.args.indexOf('--model') + 1], 'fixture model');
  assert.equal(record.args[record.args.indexOf('--session-dir') + 1], path.join(f.root, '.pi-runtime/managed/s8-main'));
  assert.ok(record.args.includes(path.join(f.root, 'pi/extensions/managed-session.mjs')));
  const before = (await readFile(path.join(f.root, 'service-starts'), 'utf8')).trim().split('\n').map(JSON.parse);
  await f.launch([]);
  const records = (await readFile(path.join(f.root, 'starts'), 'utf8')).trim().split('\n').map(JSON.parse);
  assert.equal(records.length, 2);
  assert.ok(records[1].args.includes('--continue'));
  assert.equal(records[1].args[records[1].args.indexOf('--model') + 1], 'fixture model');
  const after = (await readFile(path.join(f.root, 'service-starts'), 'utf8')).trim().split('\n').map(JSON.parse);
  assert.equal(after.length, 4);
  assert.ok(after.slice(2).every(item => !before.some(previous => previous.pid === item.pid)));
  assert.equal((await readFile(path.join(f.root, 'telegram'), 'utf8')).trim().split('\n').length, 2);
  assert.equal((await f.run(['list-windows', '-t', 's8-main', '-F', '#W'])).stdout.trim().split('\n').length, 4);
  assert.match((await f.launch(['--sessions'])).stdout, /s8-main/);
  await f.launch(['--model', 'changed model']);
  const changed = (await readFile(path.join(f.root, 'starts'), 'utf8')).trim().split('\n').map(JSON.parse).at(-1);
  assert.equal(changed.args[changed.args.indexOf('--model') + 1], 'changed model');
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

test('last launched Telegram session takes over; no-telegram sessions stay independent', async t => {
  const f = await fixture(t);
  await f.launch([]);
  await f.launch(['--session', 'work']);
  await f.launch(['--session', 'local', '--no-telegram']);
  assert.deepEqual((await readFile(path.join(f.root, 'telegram'), 'utf8')).trim().split('\n'), ['s8-main', 's8-work']);
  const records = (await readFile(path.join(f.root, 'starts'), 'utf8')).trim().split('\n').map(JSON.parse);
  const local = records.find(record => record.session === 's8-local');
  assert.ok(!local.args.some(arg => /extensions\/(managed-session|telegram)\.mjs$/.test(arg)));
  await f.launch([]);
  assert.deepEqual((await readFile(path.join(f.root, 'telegram'), 'utf8')).trim().split('\n'), ['s8-main', 's8-work', 's8-main']);
  const sessions = (await f.run(['list-sessions', '-F', '#S'])).stdout.trim().split('\n').sort();
  assert.deepEqual(sessions, ['s8-local', 's8-main', 's8-work']);
});

test('concurrent launchers serialize restarts without duplicate service processes', async t => {
  const f = await fixture(t);
  await Promise.all([f.launch([]), f.launch([])]);
  assert.equal((await readFile(path.join(f.root, 'starts'), 'utf8')).trim().split('\n').length, 2);
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


test('restart finishes even when it kills the Pi pane that requested it', async t => {
  const f = await fixture(t);
  await f.launch([]);
  const before = (await f.run(['display-message', '-p', '-t', 's8-main:pi', '#{pane_pid}'])).stdout;
  await new Promise((resolve, reject) => {
    const socket = net.connect(path.join(f.root, '.pi-runtime/s8-main.sock'));
    socket.on('error', reject);
    socket.on('connect', () => socket.write('self-restart'));
    socket.on('data', () => { socket.end(); resolve(); });
  });
  const runs = path.join(f.root, '.s8-runtime/runtime-restarts');
  let completed = false;
  for (let attempt = 0; attempt < 100; attempt++) {
    const directories = await readdir(runs);
    for (const directory of directories) {
      try {
        const request = JSON.parse(await readFile(path.join(runs, directory, 'request.json'), 'utf8'));
        const result = JSON.parse(await readFile(path.join(runs, directory, 'result.json'), 'utf8'));
        if (request.telegram === false) { assert.equal(result.ok, true); completed = true; }
      } catch (error) { if (error.code !== 'ENOENT') throw error; }
    }
    if (completed) break;
    await new Promise(resolve => setTimeout(resolve, 100));
  }
  assert.equal(completed, true);
  assert.notEqual((await f.run(['display-message', '-p', '-t', 's8-main:pi', '#{pane_pid}'])).stdout, before);
  assert.equal((await f.run(['display-message', '-p', '-t', 's8-main:pi', '#{pane_dead}'])).stdout.trim(), '0');
});
