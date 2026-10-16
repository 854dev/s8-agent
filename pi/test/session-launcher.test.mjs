import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { copyFile, mkdir, mkdtemp, realpath, writeFile, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

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

test('launcher lists managed sessions and reuses an existing session without restarting Pi', async t => {
  const dir = await mkdtemp(path.join(tmpdir(), 's8-launcher-'));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const log = path.join(dir, 'calls');
  await writeFile(path.join(dir, 'tmux'), `#!/bin/sh
printf '%s\\n' "$*" >> '${log}'
case "$1" in
  list-sessions) printf 's8-main\\t1\\nother\\t1\\ns8-unmanaged\\t\\n';;
  has-session) test -f '${dir}/created';;
  new-session) touch '${dir}/created';;
  set-option|show-option)
    case "$3" in =*) exit 1;; esac
    if [ "$1" = show-option ]; then printf '1'; fi;;
esac
`, { mode: 0o755 });
  const script = fileURLToPath(new URL('../../start-pi.sh', import.meta.url));
  const options = { encoding: 'utf8', env: { ...process.env, PATH: `${dir}:${process.env.PATH}`, TMUX: '' } };
  assert.equal(execFileSync('bash', [script, '--sessions'], options).trim(), 's8-main');
  execFileSync('bash', [script, '--no-scheduler', '--no-supervisor', '--session', 'main'], options);
  execFileSync('bash', [script, '--no-scheduler', '--no-supervisor', '--session', 'main'], options);
  const calls = await readFile(log, 'utf8');
  assert.equal(calls.match(/^new-session /gm).length, 1);
  assert.equal(calls.match(/^attach-session /gm).length, 2);
  assert.ok(calls.includes('--managed'));
  assert.ok(calls.includes('--no-scheduler'));
  assert.ok(calls.includes('--no-supervisor'));
  assert.throws(() => execFileSync('bash', [script, '--session', 'bad;name'], { ...options, stdio: 'pipe' }));
});

test('launcher exposes Projectman and scheduler tools and passes inherited credentials without printing them', async t => {
  const dir = await realpath(await mkdtemp(path.join(tmpdir(), 's8-tool-launcher-')));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const script = path.join(dir, 'start-pi.sh');
  await copyFile(new URL('../../start-pi.sh', import.meta.url), script);
  await mkdir(path.join(dir, 'pi/bin'), { recursive: true });
  await mkdir(path.join(dir, 'pi/lib'), { recursive: true });
  await copyFile(new URL('../bin/manager-options.mjs', import.meta.url), path.join(dir, 'pi/bin/manager-options.mjs'));
  await copyFile(new URL('../lib/manager-launch.mjs', import.meta.url), path.join(dir, 'pi/lib/manager-launch.mjs'));
  await mkdir(path.join(dir, 'pi/node_modules/.bin'), { recursive: true });
  const key = 'phcms_sk_' + 'A'.repeat(43);
  await writeFile(path.join(dir, 'pi/node_modules/.bin/pi'), `#!/usr/bin/env node
if (process.env.PHCMS_ACCESS_TOKEN !== ${JSON.stringify(key)} || process.env.PHCMS_API_URL !== 'http://127.0.0.1:8000/api/v2') process.exit(7);
console.log(JSON.stringify(process.argv.slice(2)));
`, { mode: 0o755 });
  const options = { encoding: 'utf8', env: { ...process.env, S8_KB_ROOT: dir, PHCMS_API_URL: 'http://127.0.0.1:8000/api/v2', PHCMS_ACCESS_TOKEN: key } };
  const output = execFileSync('bash', [script, '--no-scheduler', '--no-supervisor'], options);
  assert.equal(output.includes(key), false);
  const args = JSON.parse(output);
  const tools = args[args.indexOf('--tools') + 1].split(',');
  assert.ok(tools.includes('projectman'));
  assert.ok(tools.includes('scheduler'));
  assert.ok(args.includes(path.join(dir, 'pi/extensions/manager.ts')));
  assert.deepEqual(tools, ['projectman', 'kb', 'scheduler']);
  assert.ok(args.includes('--no-extensions'));
  assert.ok(args.includes('--no-context-files'));
  assert.throws(() => execFileSync('bash', [script, '--tools', 'read'], { ...options, stdio: 'pipe' }));
});

test('launcher enables services by default, consumes exclusion flags anywhere, and keeps utility commands side-effect free', async t => {
  const dir = await realpath(await mkdtemp(path.join(tmpdir(), 's8-combined-launcher-')));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const script = path.join(dir, 'start-pi.sh'), log = path.join(dir, 'services.json');
  await copyFile(new URL('../../start-pi.sh', import.meta.url), script);
  await mkdir(path.join(dir, 'pi/bin'), { recursive: true }); await mkdir(path.join(dir, 'pi/lib')); await mkdir(path.join(dir, 'pi/node_modules/.bin'), { recursive: true });
  await copyFile(new URL('../bin/manager-options.mjs', import.meta.url), path.join(dir, 'pi/bin/manager-options.mjs'));
  await copyFile(new URL('../lib/manager-launch.mjs', import.meta.url), path.join(dir, 'pi/lib/manager-launch.mjs'));
  await writeFile(path.join(dir, 'pi/bin/pi-services.mjs'), `import {writeFileSync} from 'node:fs'; writeFileSync(${JSON.stringify(log)}, JSON.stringify(process.argv.slice(2)));`);
  await writeFile(path.join(dir, 'pi/node_modules/.bin/pi'), "#!/usr/bin/env node\nconsole.log(JSON.stringify(process.argv.slice(2)));\n", { mode: 0o755 });
  const options = { encoding: 'utf8', env: { ...process.env, S8_KB_ROOT: dir } };
  for (const [input, expected] of [[[], []], [['--telegram'], []], [['--no-scheduler'], ['--no-scheduler']], [['--model', 'fixture model', '--no-supervisor'], ['--no-supervisor']]]) {
    await rm(log, { force: true }); const output = execFileSync('bash', [script, ...input], options);
    assert.deepEqual(JSON.parse(await readFile(log, 'utf8')), expected);
    assert.ok(!JSON.parse(output).some(arg => ['--no-scheduler', '--no-supervisor'].includes(arg)));
    assert.ok(!JSON.parse(output).includes(''));
    if (input.includes('--telegram')) assert.ok(JSON.parse(output).includes(path.join(dir, 'pi/extensions/telegram.mjs')));
  }
  for (const input of [['--no-scheduler', '--no-supervisor'], ['--help'], ['--version'], ['list']]) {
    await rm(log, { force: true }); execFileSync('bash', [script, ...input], options);
    await assert.rejects(readFile(log), { code: 'ENOENT' });
  }
  assert.throws(() => execFileSync('bash', [script, '--tools', 'bash'], { ...options, stdio: 'pipe' }));
  await assert.rejects(readFile(log), { code: 'ENOENT' });
});
