import test from 'node:test';
import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { mkdtemp, realpath, mkdir, copyFile, writeFile, readFile, readdir, rm, symlink } from 'node:fs/promises';
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
  await writeFile(path.join(root, 's8-config.yml'), 'telegram: {}\nworker-entries:\n  worker-1:\n    agent: pi\n    host: local\n    launch: managed\n');
  for (const file of ['bin/pi-runtime.mjs', 'bin/telegram-status.mjs', 'bin/pi-runtime-worker.mjs', 'bin/manager-options.mjs', 'lib/runtime/restart.mjs', 'lib/runtime/full-restart.mjs', 'lib/runtime/runtime.mjs', 'lib/runtime/services.mjs', 'lib/runtime/tmux-windows.mjs', 'lib/runtime/managed-sessions.mjs', 'lib/manager/launch.mjs', 'lib/telegram/status.mjs', 'lib/development/worker-pool.mjs', 'lib/development/worker-identity.mjs', 'lib/development/worker-communicator.mjs', 'lib/development/worker-store.mjs', 'lib/development/worker-auth.mjs', 'lib/development/worker-protocol.mjs', 'lib/runtime/process.mjs', 'lib/development/ssh-worker.mjs', 'lib/storage/json-file.mjs', 'lib/scheduler/control.mjs', 'lib/scheduler/store.mjs', 'lib/config/s8-config.mjs']) {
    await mkdir(path.dirname(path.join(root, 'pi', file)), { recursive: true });
    await copyFile(new URL(`../${file}`, import.meta.url), path.join(root, 'pi', file));
  }
  await mkdir(path.join(root, 'apps/telegram-gateway'), { recursive: true });
  await copyFile(new URL('../../apps/telegram-gateway/gateway.mjs', import.meta.url), path.join(root, 'apps/telegram-gateway/gateway.mjs'));
  await symlink(new URL('../node_modules/yaml', import.meta.url).pathname, path.join(root, 'pi/node_modules/yaml'));
  await writeFile(path.join(root, 'pi/bin/developer.mjs'), 'setInterval(() => {}, 1000);');
  for (const service of ['scheduler', 'supervisor']) await writeFile(path.join(root, `pi/bin/${service}.mjs`), `import {appendFileSync} from 'node:fs'; appendFileSync(${JSON.stringify(path.join(root, 'service-starts'))}, JSON.stringify({service:${JSON.stringify(service)},pid:process.pid})+'\\n'); setInterval(() => {}, 1000);`);
  await writeFile(path.join(root, 'tools/tmux'), `#!/bin/sh\nexec ${quote(tmux)} -f /dev/null -L ${quote(socket)} "$@"\n`, { mode: 0o755 });
  await writeFile(path.join(root, 'pi/node_modules/.bin/pi'), `#!/usr/bin/env node
import('node:fs').then(async fs => {
  const {execFileSync, spawn} = await import('node:child_process');
  const net = await import('node:net');
  const session = execFileSync('tmux', ['display-message', '-p', '#S'], {encoding:'utf8'}).trim();
  fs.appendFileSync(${JSON.stringify(path.join(root, 'starts'))}, JSON.stringify({session,args:process.argv.slice(2)})+'\\n');
  if (execFileSync('tmux', ['show-option', '-qv', '@s8-telegram'], {encoding:'utf8'}).trim() !== 'take') { setInterval(() => {}, 1000); return; }
  const socket = process.env.S8_PI_RESTART_DIR + '/' + session + '.sock';
  if (fs.existsSync(socket)) fs.unlinkSync(socket);
  net.createServer(client => client.once('data', data => {
    if (data.toString() === 'self-restart') {
      spawn('bash', [${JSON.stringify(path.join(root, 'start-pi.sh'))}, '--mode', 'project', '--no-telegram'], {stdio:'ignore'});
      client.end('ok'); return;
    }
    fs.appendFileSync(${JSON.stringify(path.join(root, 'telegram'))}, session+'\\n'); client.end('ok');
  })).listen(socket);
});
`, { mode: 0o755 });
  const launch = args => exec('bash', [path.join(root, 'start-pi.sh'), '--mode', 'project', ...args], {
    env: { ...process.env, PATH: `${root}/tools:${process.env.PATH}`, S8_KB_ROOT: root, TMUX: '' }, timeout: 12000,
  });
  return { root, run, launch };
}

test('start-pi fully restarts Pi and both services, resumes the session and connects Telegram by default', async t => {
  const f = await fixture(t);
  const result = await f.launch(['--model', 'fixture model']);
  assert.match(result.stdout, /tmux 세션: s8-main/);
  for (const name of ['shell', 'pi', 'scheduler', 'supervisor']) assert.ok(result.stdout.includes(`s8-main:${name}`));
  assert.ok((await f.run(['list-sessions', '-F', '#S'])).stdout.includes('s8-workers-'));
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
  assert.ok(local.args.includes(path.join(f.root, 'pi/extensions/managed-session.mjs')));
  assert.equal((await f.run(['show-option', '-qv', '-t', 's8-local', '@s8-telegram'])).stdout.trim(), 'off');
  await f.launch([]);
  assert.deepEqual((await readFile(path.join(f.root, 'telegram'), 'utf8')).trim().split('\n'), ['s8-main', 's8-work', 's8-main']);
  const sessions = (await f.run(['list-sessions', '-F', '#S'])).stdout.trim().split('\n').sort();
  assert.deepEqual(sessions.filter(name => !name.startsWith('s8-workers-')), ['s8-local', 's8-main', 's8-work']);
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

test('local mode works without KB or project config and does not start services', async t => {
  const f = await fixture(t);
  const result = await f.launch(['--mode', 'local', '--cwd', f.root]);
  assert.match(result.stdout, /s8-local/);
  await assert.rejects(readFile(path.join(f.root, 'service-starts')), { code: 'ENOENT' });
  const first = JSON.parse((await readFile(path.join(f.root, 'starts'), 'utf8')).trim());
  assert.ok(first.args.includes(path.join(f.root, 'pi/extensions/local.mjs')));
  assert.ok(first.args.includes(path.join(f.root, 'pi/extensions/managed-session.mjs')));
  assert.equal(first.args[first.args.indexOf('--tools') + 1], 'read,bash,edit,write,grep,find,ls');
  await f.launch(['--mode', 'local', '--cwd', f.root]);
  const second = (await readFile(path.join(f.root, 'starts'), 'utf8')).trim().split('\n').map(JSON.parse).at(-1);
  assert.ok(second.args.includes('--continue'));
  const other = path.join(f.root, 'other');
  await mkdir(other);
  await f.launch(['--mode', 'local', '--cwd', other]);
  const changed = (await readFile(path.join(f.root, 'starts'), 'utf8')).trim().split('\n').map(JSON.parse).at(-1);
  assert.ok(!changed.args.includes('--continue'));
  assert.notEqual(changed.args[changed.args.indexOf('--session-dir') + 1], first.args[first.args.indexOf('--session-dir') + 1]);
  await f.launch([]);
  const services = await readFile(path.join(f.root, 'service-starts'), 'utf8');
  await f.launch(['--mode', 'local', '--cwd', other]);
  assert.equal(await readFile(path.join(f.root, 'service-starts'), 'utf8'), services);
});

test('noninteractive mode selection fails early; help and invalid modes are explicit', async t => {
  const f = await fixture(t);
  await assert.rejects(exec('bash', [path.join(f.root, 'start-pi.sh')]), /--mode project/);
  await assert.rejects(f.launch(['--mode', 'invalid']), /모드는 project 또는 local/);
  assert.match((await f.launch(['--help'])).stdout, /--mode project\|local/);
});

test('telegram take/off aliases and saved preference survive runtime restart', async t => {
  const f = await fixture(t);
  await f.launch(['--telegram', 'off']);
  assert.equal((await f.run(['show-option', '-qv', '-t', 's8-main', '@s8-telegram'])).stdout.trim(), 'off');
  await f.launch([]);
  await assert.rejects(readFile(path.join(f.root, 'telegram')), { code: 'ENOENT' });
  await f.launch(['--telegram', 'take']);
  assert.equal((await f.run(['show-option', '-qv', '-t', 's8-main', '@s8-telegram'])).stdout.trim(), 'take');
  await f.launch(['--no-telegram']);
  await f.launch([]);
  assert.equal((await readFile(path.join(f.root, 'telegram'), 'utf8')).trim(), 's8-main');
  await assert.rejects(f.launch(['--telegram', 'unknown']), /take 또는 off/);
});

test('interactive startup shows mode and Telegram choices and defaults to keeping the connection', async t => {
  const f = await fixture(t);
  const script = `import os, pty, select, subprocess, sys, time
master, slave = pty.openpty()
p = subprocess.Popen(['bash', sys.argv[1]], stdin=slave, stdout=slave, stderr=slave)
os.close(slave)
os.write(master, b'2\\n1\\n')
output = bytearray()
deadline = time.monotonic() + 20
while time.monotonic() < deadline:
    if select.select([master], [], [], 0.1)[0]:
        try:
            data = os.read(master, 65536)
            if not data: break
            output.extend(data)
        except OSError: break
    if p.poll() is not None: break
if p.poll() is None:
    p.kill()
    raise RuntimeError('interactive launch timed out')
os.close(master)
sys.stdout.buffer.write(output)
sys.exit(p.wait())
`;
  const { stdout } = await exec('python3', ['-c', script, path.join(f.root, 'start-pi.sh')], {
    cwd: f.root, env: { ...process.env, PATH: `${f.root}/tools:${process.env.PATH}`, S8_KB_ROOT: f.root, TMUX: '' }, timeout: 25000,
  });
  assert.match(stdout, /실행 모드/);
  assert.match(stdout, /Telegram 현재 연결/);
  assert.match(stdout, /현재 연결 유지/);
  assert.match(stdout, /여기로 가져오기/);
  assert.match(stdout, /s8-local/);
  assert.equal((await f.run(['show-option', '-qv', '-t', 's8-local', '@s8-telegram'])).stdout.trim(), 'off');
});
