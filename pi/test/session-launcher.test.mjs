import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { copyFile, mkdir, mkdtemp, realpath, writeFile, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { MANAGER_TOOLS } from '../lib/manager/launch.mjs';

test('unified foreground service entrypoints preserve scheduler setup and supervisor diagnostic arguments', async t => {
  const dir = await realpath(await mkdtemp(path.join(tmpdir(), 's8-service-entry-')));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const script = path.join(dir, 'start-pi.sh');
  await copyFile(new URL('../../start-pi.sh', import.meta.url), script);
  await mkdir(path.join(dir, 'pi/bin'), { recursive: true });
  await mkdir(path.join(dir, 'pi/node_modules/.bin'), { recursive: true });
  await writeFile(path.join(dir, 'pi/node_modules/.bin/pi'), '#!/bin/sh\nexit 0\n', { mode: 0o755 });
  const stub = "console.log(JSON.stringify({args:process.argv.slice(2),cwd:process.cwd(),kb:process.env.S8_KB_ROOT,config:process.env.S8_PI_CONFIG_ROOT}));";
  for (const service of ['scheduler', 'supervisor']) await writeFile(path.join(dir, `pi/bin/${service}.mjs`), stub);
  const options = { encoding: 'utf8', env: { ...process.env, S8_KB_ROOT: '.' }, cwd: dir };
  const scheduler = JSON.parse(execFileSync('bash', [script, '--service', 'scheduler'], options));
  assert.equal(scheduler.cwd, dir);
  assert.equal(scheduler.kb, dir);
  assert.equal(scheduler.config, path.join(dir, 'pi'));
  for (const flag of ['--help', '--check', '--once']) {
    const result = JSON.parse(execFileSync('bash', [script, '--service', 'supervisor', flag], options));
    assert.deepEqual(result.args, [flag]);
  }
  for (const args of [['--service', 'unknown'], ['--service', 'scheduler', '--once']]) {
    assert.throws(() => execFileSync('bash', [script, ...args], { ...options, stdio: 'pipe' }));
  }
});

test('launcher exposes general and Projectman tools and passes inherited credentials without printing them', async t => {
  const dir = await realpath(await mkdtemp(path.join(tmpdir(), 's8-tool-launcher-')));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const script = path.join(dir, 'start-pi.sh');
  await copyFile(new URL('../../start-pi.sh', import.meta.url), script);
  await mkdir(path.join(dir, 'pi/bin'), { recursive: true });
  await mkdir(path.join(dir, 'pi/lib/manager'), { recursive: true });
  await copyFile(new URL('../bin/manager-options.mjs', import.meta.url), path.join(dir, 'pi/bin/manager-options.mjs'));
  await copyFile(new URL('../lib/manager/launch.mjs', import.meta.url), path.join(dir, 'pi/lib/manager/launch.mjs'));
  await mkdir(path.join(dir, 'pi/node_modules/.bin'), { recursive: true });
  const key = 'phcms_sk_' + 'A'.repeat(43);
  await writeFile(path.join(dir, 'pi/node_modules/.bin/pi'), `#!/usr/bin/env node
if (process.env.PHCMS_ACCESS_TOKEN !== ${JSON.stringify(key)} || process.env.PHCMS_API_URL !== 'http://127.0.0.1:8000/api/v2') process.exit(7);
console.log(JSON.stringify(process.argv.slice(2)));
`, { mode: 0o755 });
  const options = { encoding: 'utf8', env: { ...process.env, S8_KB_ROOT: dir, PHCMS_API_URL: 'http://127.0.0.1:8000/api/v2', PHCMS_ACCESS_TOKEN: key } };
  await writeFile(path.join(dir, 'tmux'), '#!/bin/sh\nprintf s8-fixture\n', { mode: 0o755 });
  options.env.PATH = `${dir}:${process.env.PATH}`;
  const managed = (...args) => execFileSync('bash', [script, '--managed', '--mode', 'project', '--cwd', dir, ...args], options);
  const output = managed('--telegram');
  assert.equal(output.includes(key), false);
  const args = JSON.parse(output);
  const tools = args[args.indexOf('--tools') + 1].split(',');
  assert.ok(tools.includes('projectman'));
  assert.ok(tools.includes('scheduler'));
  assert.ok(args.includes(path.join(dir, 'pi/extensions/manager.ts')));
  assert.deepEqual(tools, MANAGER_TOOLS);
  assert.ok(args.includes('--no-extensions'));
  assert.ok(args.includes('--no-context-files'));
  assert.ok(args.includes(path.join(dir, 'pi/extensions/managed-session.mjs')));
  const standalone = JSON.parse(managed('--no-telegram'));
  assert.ok(standalone.includes(path.join(dir, 'pi/extensions/managed-session.mjs')));
  assert.throws(() => execFileSync('bash', [script, '--managed', '--mode', 'project', '--cwd', dir, '--no-telegram', '--tools', 'read'], { ...options, stdio: 'pipe' }));
  assert.throws(() => execFileSync('bash', [script, '--managed', '--mode', 'project'], { ...options, stdio: 'pipe' }), /내부 실행 인자/);
});

test('launcher forwards user commands to the Node entrypoint and runs foreground commands directly', async t => {
  const dir = await realpath(await mkdtemp(path.join(tmpdir(), 's8-combined-launcher-')));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const script = path.join(dir, 'start-pi.sh');
  await copyFile(new URL('../../start-pi.sh', import.meta.url), script);
  await mkdir(path.join(dir, 'pi/bin'), { recursive: true });
  await mkdir(path.join(dir, 'pi/lib/manager'), { recursive: true });
  await mkdir(path.join(dir, 'pi/node_modules/.bin'), { recursive: true });
  await copyFile(new URL('../bin/manager-options.mjs', import.meta.url), path.join(dir, 'pi/bin/manager-options.mjs'));
  await copyFile(new URL('../lib/manager/launch.mjs', import.meta.url), path.join(dir, 'pi/lib/manager/launch.mjs'));
  await writeFile(path.join(dir, 'pi/bin/pi-runtime.mjs'), 'console.log(JSON.stringify({runtime:process.argv.slice(2)}));');
  await writeFile(path.join(dir, 'pi/node_modules/.bin/pi'), '#!/usr/bin/env node\nconsole.log(JSON.stringify({pi:process.argv.slice(2)}));\n', { mode: 0o755 });
  const options = { encoding: 'utf8', env: { ...process.env, S8_KB_ROOT: dir } };
  for (const input of [[], ['--mode', 'project', '--telegram', 'off', '--session', 'work'], ['--help']]) {
    assert.deepEqual(JSON.parse(execFileSync('bash', [script, ...input], options)).runtime, input);
  }
  const foreground = args => JSON.parse(execFileSync('bash', [script, '--foreground', '--mode', 'local', '--cwd', dir, '--no-telegram', ...args], options));
  assert.deepEqual(foreground(['list']).pi, ['list']);
  const version = foreground(['--version']).pi;
  assert.ok(version.includes('--version'));
  assert.ok(!version.includes(path.join(dir, 'pi/extensions/managed-session.mjs')));
});
