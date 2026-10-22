import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync, spawn } from 'node:child_process';
import { copyFile, mkdir, mkdtemp, realpath, writeFile, readFile, rm, symlink } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { MANAGER_TOOLS } from '../extensions/manager.ts';

/** 실행 스크립트(start-*-agent.sh, s8.sh)와 Node 진입점·프로필을 임시 저장소에 복사한다. */
async function copyLauncher(dir) {
  for (const file of ['start-general-agent.sh', 'start-manager-agent.sh', 'start-worker-agent.sh', 's8.sh', 'agents/general/profile.json', 'agents/manager/profile.json', 'agents/worker/profile.json']) {
    await mkdir(path.dirname(path.join(dir, file)), { recursive: true });
    await copyFile(new URL(`../../${file}`, import.meta.url), path.join(dir, file));
  }
  for (const file of ['bin/agent.mjs', 'bin/s8.mjs', 'lib/agent/launch.mjs', 'lib/agent/profile.mjs', 'lib/config/s8-config.mjs']) {
    await mkdir(path.dirname(path.join(dir, 'pi', file)), { recursive: true });
    await copyFile(new URL(`../${file}`, import.meta.url), path.join(dir, 'pi', file));
  }
  await mkdir(path.join(dir, 'pi/node_modules/.bin'), { recursive: true });
  await symlink(new URL('../node_modules/yaml', import.meta.url).pathname, path.join(dir, 'pi/node_modules/yaml'));
  // KB는 임시 저장소 자신으로 둔다.
  await writeFile(path.join(dir, 's8-config.yml'), 'kbRoot: .\n');
  return { general: path.join(dir, 'start-general-agent.sh'), manager: path.join(dir, 'start-manager-agent.sh'), worker: path.join(dir, 'start-worker-agent.sh'), s8: path.join(dir, 's8.sh') };
}

/** 받은 인자와 연결 설정을 JSON으로 출력하는 가짜 Pi. */
const echoPi = dir => writeFile(path.join(dir, 'pi/node_modules/.bin/pi'), `#!/usr/bin/env node
console.log(JSON.stringify({ args: process.argv.slice(2), cwd: process.cwd(), url: process.env.PHCMS_API_URL ?? null }));
`, { mode: 0o755 });

test('s8 service runs the scheduler in the KB with the Pi environment and rejects other services', async t => {
  const dir = await realpath(await mkdtemp(path.join(tmpdir(), 's8-service-entry-')));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const { s8 } = await copyLauncher(dir);
  await writeFile(path.join(dir, 'pi/node_modules/.bin/pi'), '#!/bin/sh\nexit 0\n', { mode: 0o755 });
  await writeFile(path.join(dir, 'pi/bin/scheduler.mjs'), "console.log(JSON.stringify({args:process.argv.slice(2),cwd:process.cwd(),kb:process.env.S8_KB_ROOT,config:process.env.S8_PI_CONFIG_ROOT}));");
  const options = { encoding: 'utf8', env: { ...process.env }, cwd: dir };
  const scheduler = JSON.parse(execFileSync('bash', [s8, 'service', 'scheduler'], options));
  assert.equal(scheduler.cwd, dir);
  assert.equal(scheduler.kb, dir);
  assert.equal(scheduler.config, path.join(dir, 'pi'));
  for (const args of [['service', 'supervisor'], ['service', 'scheduler', '--once'], ['work'], ['work', 'a', 'b']]) {
    assert.throws(() => execFileSync('bash', [s8, ...args], { ...options, stdio: 'pipe' }));
  }
});

test('manager mode exposes Projectman tools, works in the KB and passes credentials without printing them', async t => {
  const dir = await realpath(await mkdtemp(path.join(tmpdir(), 's8-manager-launcher-')));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const { manager: agent } = await copyLauncher(dir);
  await echoPi(dir);
  const key = 'phcms_sk_' + 'A'.repeat(43);
  const options = { encoding: 'utf8', env: { ...process.env, PHCMS_ACCESS_TOKEN: key } };
  const output = execFileSync('bash', [agent, '--control', '--session-dir', path.join(dir, '.pi-runtime/managed/s8-main')], options);
  assert.equal(output.includes(key), false);
  const { args, cwd } = JSON.parse(output);
  assert.equal(cwd, dir);
  assert.deepEqual(args[args.indexOf('--tools') + 1].split(','), MANAGER_TOOLS);
  assert.ok(args.includes(path.join(dir, 'pi/extensions/manager.ts')));
  assert.ok(args.includes(path.join(dir, 'pi/extensions/managed-session.mjs')));
  assert.equal(args[args.indexOf('--session-dir') + 1], path.join(dir, '.pi-runtime/managed/s8-main'));
  assert.throws(() => execFileSync('bash', [agent, '--tools', 'read'], { ...options, stdio: 'pipe' }), /Unsupported/);
  assert.throws(() => execFileSync('bash', [agent, '--session-dir', '/tmp/elsewhere'], { ...options, stdio: 'pipe' }), /\.pi-runtime/);
  assert.throws(() => execFileSync('bash', [agent, '--mode', 'worker'], { ...options, stdio: 'pipe' }), /start-worker-agent\.sh/);
  assert.throws(() => execFileSync('node', [path.join(dir, 'pi/bin/agent.mjs'), 'local'], { ...options, stdio: 'pipe' }), /start-general-agent\.sh/);
});

test('general and worker launchers run in the invocation directory and package commands pass to Pi', async t => {
  const dir = await realpath(await mkdtemp(path.join(tmpdir(), 's8-general-launcher-')));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const { general: agent, worker: workerAgent, s8 } = await copyLauncher(dir);
  await echoPi(dir);
  const work = path.join(dir, 'work');
  await mkdir(work);
  const options = { encoding: 'utf8', cwd: work, env: { ...process.env } };
  const general = JSON.parse(execFileSync('bash', [agent, '--print'], options));
  assert.equal(general.cwd, work);
  assert.ok(general.args.includes(path.join(dir, 'pi/extensions/general.mjs')));
  assert.equal(general.args[general.args.indexOf('--tools') + 1], 'read,bash,edit,write,grep,find,ls');
  assert.ok(!general.args.some(arg => arg.endsWith('telegram.mjs') || arg.endsWith('managed-session.mjs')));
  assert.deepEqual(JSON.parse(execFileSync('bash', [agent, 'list'], options)).args, ['list']);
  assert.match(execFileSync('bash', [agent, '--help'], options), /start-general-agent\.sh \[--cwd/);
  assert.match(execFileSync('bash', [workerAgent, '--help'], options), /--uid UID/);
  // 워커 모드는 실행 위치에서 작업하고, --uid가 있으면 작업 지시를 마지막 인자로 넣는다.
  const worker = JSON.parse(execFileSync('bash', [workerAgent, '--uid', 'task-1', '--print'], options));
  assert.equal(worker.cwd, work);
  assert.ok(worker.args.includes(path.join(dir, 'pi/extensions/worker.ts')));
  assert.equal(worker.args.at(-1), 'uid task-1 의 업무를 수행해라.');
  assert.throws(() => execFileSync('bash', [agent, '--uid', 'task-1'], { ...options, stdio: 'pipe' }), /worker 모드/);
  // tmux 런타임 명령은 s8.sh로 넘어간다.
  await mkdir(path.join(dir, 'pi/lib/runtime'), { recursive: true });
  await writeFile(path.join(dir, 'pi/lib/runtime/user-command.mjs'), 'export async function runUserCommand(_root, input) { console.log(JSON.stringify({ runtime: input })); }');
  for (const input of [[], ['--mode', 'project', '--telegram', 'off', '--session', 'work']]) {
    assert.deepEqual(JSON.parse(execFileSync('bash', [s8, ...input], options)).runtime, input);
  }
});

test('all launcher modes pass the .env ClinePass key to Pi without putting it in arguments or output', async t => {
  const dir = await realpath(await mkdtemp(path.join(tmpdir(), 's8-clinepass-launcher-')));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const launchers = await copyLauncher(dir);
  await writeFile(path.join(dir, '.env'), 'CLINE_API_KEY=fixture-clinepass-key\n');
  await writeFile(path.join(dir, 'pi/node_modules/.bin/pi'), `#!/usr/bin/env node
console.log(JSON.stringify({ args: process.argv.slice(2), keyMatches: process.env.CLINE_API_KEY === 'fixture-clinepass-key' }));
`, { mode: 0o755 });
  for (const mode of ['general', 'manager', 'worker']) {
    const output = execFileSync('bash', [launchers[mode], '--provider', 'clinepass', '--model', 'cline-pass/glm-5.3', '--print'], {
      encoding: 'utf8', cwd: dir, env: { ...process.env, CLINE_API_KEY: 'fixture-inherited-key' },
    });
    assert.ok(!output.includes('fixture-clinepass-key'), mode);
    const { args, keyMatches } = JSON.parse(output);
    assert.equal(keyMatches, true, mode);
    assert.ok(args.includes(path.join(dir, 'pi/node_modules/pi-clinepass-provider/src/index.ts')), mode);
    assert.equal(args[args.indexOf('--provider') + 1], 'clinepass');
  }
});

test('agent restarts with --continue on request, loads .env with shell syntax and stops on SIGTERM', async t => {
  const dir = await realpath(await mkdtemp(path.join(tmpdir(), 's8-foreground-')));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const { manager: agent } = await copyLauncher(dir);
  // 첫 실행은 /restart처럼 restart-<부모 PID> 파일을 남기고 종료하고, 다음 실행은 인자를 기록한다.
  await writeFile(path.join(dir, 'pi/node_modules/.bin/pi'), `#!/usr/bin/env node
const fs = require('node:fs'), path = require('node:path');
const runs = path.join(${JSON.stringify(dir)}, 'runs');
fs.appendFileSync(runs, JSON.stringify({ args: process.argv.slice(2), url: process.env.PHCMS_API_URL, key: process.env.PHCMS_ACCESS_TOKEN }) + '\\n');
if (process.argv.includes('fixture-wait')) setInterval(() => {}, 1000);
else if (fs.readFileSync(runs, 'utf8').trim().split('\\n').length === 1) fs.writeFileSync(path.join(process.env.S8_PI_RESTART_DIR, 'restart-' + process.ppid), 'restart');
`, { mode: 0o755 });
  // .env는 셸 문법(변수 확장, export)을 그대로 지원해야 한다. 연결 주소는 .env가 아니라 s8-config.yml이 정한다.
  await writeFile(path.join(dir, '.env'), 'BASE=fixture\nexport PHCMS_ACCESS_TOKEN="$BASE-key"\nPHCMS_API_URL=http://ignored.invalid\n');
  await writeFile(path.join(dir, 's8-config.yml'), 'kbRoot: .\nprojectman:\n  apiUrl: http://127.0.0.1:8000/api/v2\n');
  const env = { ...process.env, PHCMS_API_URL: 'http://inherited.invalid' };
  execFileSync('bash', [agent, '--print'], { encoding: 'utf8', env });
  const runs = (await readFile(path.join(dir, 'runs'), 'utf8')).trim().split('\n').map(JSON.parse);
  assert.equal(runs.length, 2);
  assert.ok(!runs[0].args.includes('--continue'));
  assert.ok(runs[1].args.includes('--continue'));
  assert.ok(runs.every(run => run.url === 'http://127.0.0.1:8000/api/v2' && run.key === 'fixture-key'));
  const child = spawn('bash', [agent, '--print', '--model', 'fixture-wait'], { env, stdio: 'ignore' });
  t.after(() => child.kill('SIGKILL'));
  for (let i = 0; i < 100 && (await readFile(path.join(dir, 'runs'), 'utf8')).trim().split('\n').length < 3; i++) await new Promise(resolve => setTimeout(resolve, 50));
  child.kill('SIGTERM');
  assert.equal(await new Promise(resolve => child.once('exit', code => resolve(code))), 0);
});
