import test from 'node:test';
import assert from 'node:assert/strict';
import { copyFile, mkdtemp, mkdir, writeFile, readFile, rm, symlink, link } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { applyS8Config, loadS8Config, loadTelegramConfig } from '../lib/config/s8-config.mjs';
import { runScheduler } from '../lib/scheduler/daemon.mjs';

async function tempRoot(t, name) {
  const root = await mkdtemp(path.join(os.tmpdir(), name));
  t.after(() => rm(root, { recursive: true, force: true }));
  return root;
}

test('a missing file uses defaults, the file is the only source, and environment IDs are ignored', async t => {
  const root = await tempRoot(t, 's8-config-');
  const previous = process.env.TELEGRAM_ALLOWED_USER_IDS;
  process.env.TELEGRAM_ALLOWED_USER_IDS = '123';
  t.after(() => { if (previous === undefined) delete process.env.TELEGRAM_ALLOWED_USER_IDS; else process.env.TELEGRAM_ALLOWED_USER_IDS = previous; });
  assert.deepEqual(loadS8Config(root), {
    kbRoot: path.resolve(root, '../854_md'),
    projectman: { apiUrl: null, startCommand: null },
    network: { bindIp: '127.0.0.1', httpPort: 80 },
    workers: [],
    communication: { enabled: false, url: null, tokenFile: null },
    telegram: { allowedUserIds: [], allowedGroupIds: [], scheduleChatId: null },
    publicUrl: null,
  });
  await writeFile(path.join(root, 's8-config.yml'), `kbRoot: kb
projectman:
  apiUrl: http://127.0.0.1:8000/api/v2/
  startCommand: cd ../ph-cms && pnpm dev
network:
  bindIp: 100.64.0.1
  httpPort: 8080
workers:
  - id: dev-a
    mode: active
  - id: dev-b
telegram:
  allowedUserIds: ["789", "789"]
  allowedGroupIds: ["-987"]
  scheduleChatId: "-987"
publicUrl: https://s8.example.invalid/s8/
`);
  assert.deepEqual(loadS8Config(root), {
    kbRoot: path.join(root, 'kb'),
    projectman: { apiUrl: 'http://127.0.0.1:8000/api/v2', startCommand: 'cd ../ph-cms && pnpm dev' },
    network: { bindIp: '100.64.0.1', httpPort: 8080 },
    workers: [{ id: 'dev-a', mode: 'active' }, { id: 'dev-b', mode: 'passive' }],
    communication: { enabled: false, url: null, tokenFile: null },
    telegram: { allowedUserIds: ['789'], allowedGroupIds: ['-987'], scheduleChatId: '-987' },
    publicUrl: 'https://s8.example.invalid/s8/',
  });
  await writeFile(path.join(root, 's8-config.yml'), 'telegram: {}\n');
  assert.deepEqual(loadTelegramConfig(root), { allowedUserIds: [], allowedGroupIds: [], scheduleChatId: null });
});

test('a leading ~ in kbRoot means the home directory', async t => {
  const root = await tempRoot(t, 's8-config-home-');
  for (const [value, expected] of [['~/kb', path.join(os.homedir(), 'kb')], ['~', os.homedir()], ['kb/~x', path.join(root, 'kb/~x')]]) {
    await writeFile(path.join(root, 's8-config.yml'), `kbRoot: ${JSON.stringify(value)}\n`);
    assert.equal(loadS8Config(root).kbRoot, expected);
  }
});

test('settings reach child processes as internal environment values and unset items are removed', async t => {
  const root = await tempRoot(t, 's8-config-env-');
  await writeFile(path.join(root, 's8-config.yml'), 'kbRoot: /srv/kb\nprojectman:\n  apiUrl: http://127.0.0.1:8000/api/v2\n');
  const env = { PHCMS_START_COMMAND: 'stale', PHCMS_ACCESS_TOKEN: 'fixture-secret' };
  applyS8Config(root, env);
  assert.deepEqual(env, { PHCMS_ACCESS_TOKEN: 'fixture-secret', S8_KB_ROOT: '/srv/kb', PHCMS_API_URL: 'http://127.0.0.1:8000/api/v2', S8_BIND_IP: '127.0.0.1', S8_HTTP_PORT: '80' });
});

test('malformed, unsafe, unknown, linked, or credential-bearing configs fail without showing values', async t => {
  const root = await tempRoot(t, 's8-config-invalid-');
  const file = path.join(root, 's8-config.yml');
  for (const yaml of [
    'telegram: [', '[]', 'telegram: []', 'telegram:\n  allowedUserIds: 123',
    'telegram:\n  allowedUserIds: ["9007199254740992"]',
    'telegram:\n  allowedUserIds: ["-123"]\n  scheduleChatId: "-123"',
    'telegram:\n  allowedGroupIds: ["123"]\n  scheduleChatId: "123"',
    'telegram:\n  allowedUserIds: ["123"]\n  scheduleChatId: "456"',
    'telegram:\n  allowedUserIds: ["123"]\n  allowedUserIds: ["456"]',
    'telegram:\n  allowedUserIds: &ids ["123"]\n  allowedGroupIds: *ids',
    'telegram:\n  botToken: fixture-value-do-not-display',
    'serviceKey: fixture-value-do-not-display',
    'projectman:\n  accessToken: fixture-value-do-not-display',
    'projectman:\n  apiUrl: https://user:fixture-value-do-not-display@example.invalid',
    'network:\n  bindIp: 0.0.0.0', 'network:\n  bindIp: fixture-value-do-not-display', 'network:\n  httpPort: 0', 'network:\n  httpPort: "80"',
    'kbRoot: ["fixture-value-do-not-display"]', 'kbRoot: "a\\nfixture-value-do-not-display"',
    'publicUrl: https://s8.example.invalid/?token=fixture-value-do-not-display',
    'infra:\n  runtime: native', 'workers: 1', 'workers:\n  - id: Dev', 'workers:\n  - id: a\n  - id: a', 'workers:\n  - id: a\n    mode: busy', 'workers:\n  - id: a\n    extra: 1', 'worker-entries: {}',
  ]) {
    await writeFile(file, yaml);
    assert.throws(() => loadS8Config(root), error => !error.message.includes('fixture-value-do-not-display'), yaml);
  }
  await writeFile(file, 'worker-entries: {}\nfoo: 1\n');
  assert.throws(() => loadS8Config(root), /unknown top-level keys: worker-entries, foo/);
  await rm(file);
  const other = path.join(root, 'other.yml');
  await writeFile(other, 'telegram: {}');
  await symlink(other, file);
  assert.throws(() => loadS8Config(root), /regular file/);
  await rm(file);
  await link(other, file);
  assert.throws(() => loadS8Config(root), /unlinked/);
});

test('the config command exports shell-safe values for the router and never reads .env', async t => {
  const root = await tempRoot(t, 's8-config-cli-');
  await mkdir(path.join(root, 'pi/bin'), { recursive: true });
  await mkdir(path.join(root, 'pi/lib/config'), { recursive: true });
  await mkdir(path.join(root, 'pi/node_modules'));
  await symlink(fileURLToPath(new URL('../node_modules/yaml', import.meta.url)), path.join(root, 'pi/node_modules/yaml'), 'dir');
  await copyFile(new URL('../bin/s8-config.mjs', import.meta.url), path.join(root, 'pi/bin/s8-config.mjs'));
  await copyFile(new URL('../lib/config/s8-config.mjs', import.meta.url), path.join(root, 'pi/lib/config/s8-config.mjs'));
  const kb = path.join(root, "it's $HOME `kb`");
  await writeFile(path.join(root, 's8-config.yml'), `kbRoot: ${JSON.stringify(kb)}\nprojectman:\n  startCommand: pnpm dev\nnetwork:\n  httpPort: 9090\n`);
  await writeFile(path.join(root, '.env'), 'PHCMS_ACCESS_TOKEN=fixture-secret-not-exported\n');
  const cli = path.join(root, 'pi/bin/s8-config.mjs');
  const exported = execFileSync(process.execPath, [cli, 'shell-env'], { encoding: 'utf8' });
  assert.equal(exported.includes('fixture-secret'), false);
  const values = execFileSync('bash', ['-c', `eval "$1"; printf '%s\\0' "$S8_KB_ROOT" "$S8_BIND_IP" "$S8_HTTP_PORT"`, 'bash', exported], { encoding: 'utf8' });
  assert.deepEqual(values.split('\0').slice(0, 3), [kb, '127.0.0.1', '9090']);
  assert.equal(execFileSync(process.execPath, [cli, 'start-command'], { encoding: 'utf8' }), 'pnpm dev');
  assert.equal(JSON.parse(execFileSync(process.execPath, [cli, 'show'], { encoding: 'utf8' })).kbRoot, kb);
  assert.throws(() => execFileSync(process.execPath, [cli, 'init'], { stdio: 'pipe' }), error => /Usage/.test(error.stderr));
});

test('scheduler delivery uses the shared YAML target and invalid config leaves no owner lock', async t => {
  const agent = await tempRoot(t, 's8-config-scheduler-');
  const root = path.join(agent, '.s8-runtime/scheduler');
  await mkdir(path.join(root, 'scripts'), { recursive: true });
  await writeFile(path.join(agent, 's8-config.yml'), 'telegram:\n  allowedUserIds: ["789"]\n  scheduleChatId: "789"');
  await writeFile(path.join(root, 'scripts/check.sh'), 'echo config-check');
  await writeFile(path.join(root, 'jobs.json'), JSON.stringify({ version: 1, jobs: [{ id: 'check', intervalMinutes: 5, timezone: 'Asia/Seoul', enabled: true }] }));
  const sent = [];
  const options = { root, cwd: agent, env: { TELEGRAM_BOT_TOKEN: 'fixture-bot' }, now: () => new Date('2026-10-14T00:00:00Z'), fetchImpl: async (_url, options) => {
    sent.push(JSON.parse(options.body));
    return { ok: true, json: async () => ({ ok: true }) };
  } };
  const stop = await runScheduler(options);
  await stop();
  assert.equal(sent.length, 1);
  assert.equal(sent[0].chat_id, '789');
  assert.match(sent[0].text, /config-check/);
  await writeFile(path.join(agent, 's8-config.yml'), 'telegram: [');
  await assert.rejects(runScheduler(options), /Invalid s8-config.yml/);
  await assert.rejects(readFile(path.join(root, 'owner.lock')), { code: 'ENOENT' });
});

test('communication needs only the comm-center URL and a token file', async t => {
  const root = await tempRoot(t, 's8-communication-config-');
  await writeFile(path.join(root, 's8-config.yml'), 'communication:\n  enabled: true\n  url: ws://10.0.0.10:8090\n  tokenFile: token.json\n');
  const config = loadS8Config(root);
  assert.deepEqual(config.communication, { enabled: true, url: 'ws://10.0.0.10:8090/', tokenFile: path.join(root, 'token.json') });
  assert.equal(config.projectman.apiUrl, null);
  assert.deepEqual(config.workers, []);
});

test('communication rejects invalid settings without exposing configuration contents', async t => {
  const root = await tempRoot(t, 's8-communication-invalid-');
  for (const fragment of [
    'enabled: yes', 'enabled: true', 'enabled: true\n  url: ws://host.invalid', 'role: worker',
    'url: https://host.invalid', 'url: ws://user:fixture-secret@host.invalid',
    'url: ws://host.invalid/?token=fixture-secret', 'url: ws://host.invalid/path', 'tokenFile: []',
  ]) {
    await writeFile(path.join(root, 's8-config.yml'), `communication:\n  ${fragment}\n`);
    assert.throws(() => loadS8Config(root), error => !error.message.includes('fixture-secret'), fragment);
  }
});

test('removed communicator settings are rejected', async t => {
  const root = await tempRoot(t, 's8-message-config-');
  for (const key of ['repositories: {}', 'server: {}', 'nodeId: host', 'managerUrl: ws://host.invalid', 'credentialsFile: secrets.json']) {
    await writeFile(path.join(root, 's8-config.yml'), `communication:\n  ${key}\n`);
    assert.throws(() => loadS8Config(root), /unknown communication keys/, key);
  }
});

