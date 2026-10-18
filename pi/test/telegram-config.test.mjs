import test from 'node:test';
import assert from 'node:assert/strict';
import { copyFile, mkdtemp, mkdir, writeFile, readFile, rm, symlink, link } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { loadTelegramConfig } from '../lib/telegram-config.mjs';
import { runScheduler } from '../lib/scheduler-daemon.mjs';

const legacy = { TELEGRAM_ALLOWED_USER_IDS: '123,123', TELEGRAM_ALLOWED_GROUP_IDS: '-456', S8_SCHEDULE_TELEGRAM_CHAT_ID: '123' };

test('missing file uses legacy IDs; a present file is the sole authority including empty lists', async t => {
  const root = await mkdtemp(path.join(os.tmpdir(), 's8-config-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  assert.deepEqual(loadTelegramConfig(root, legacy), { allowedUserIds: ['123'], allowedGroupIds: ['-456'], scheduleChatId: '123', source: 'environment' });
  await writeFile(path.join(root, 's8-config.yml'), 'telegram:\n  allowedUserIds: ["789"]\n  allowedGroupIds: ["-987"]\n  scheduleChatId: "-987"\n');
  assert.deepEqual(loadTelegramConfig(root, { ...legacy, TELEGRAM_ALLOWED_USER_IDS: 'invalid' }), { allowedUserIds: ['789'], allowedGroupIds: ['-987'], scheduleChatId: '-987', source: 'file' });
  await writeFile(path.join(root, 's8-config.yml'), 'telegram: {}\n');
  assert.deepEqual(loadTelegramConfig(root, legacy), { allowedUserIds: [], allowedGroupIds: [], scheduleChatId: null, source: 'file' });
});

test('malformed, unsafe, unauthorized, linked, or credential-bearing configs never fall back', async t => {
  const root = await mkdtemp(path.join(os.tmpdir(), 's8-config-invalid-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const file = path.join(root, 's8-config.yml');
  for (const yaml of [
    'telegram: [', '{}', 'telegram: []', 'telegram:\n  allowedUserIds: 123',
    'telegram:\n  allowedUserIds: ["9007199254740992"]',
    'telegram:\n  allowedUserIds: ["-123"]\n  scheduleChatId: "-123"',
    'telegram:\n  allowedGroupIds: ["123"]\n  scheduleChatId: "123"',
    'telegram:\n  allowedUserIds: ["123"]\n  scheduleChatId: "456"',
    'telegram:\n  allowedUserIds: ["123"]\n  allowedUserIds: ["456"]',
    'telegram:\n  allowedUserIds: &ids ["123"]\n  allowedGroupIds: *ids',
    'telegram:\n  botToken: fixture-value-do-not-display',
    'serviceKey: fixture-value-do-not-display\ntelegram: {}',
  ]) {
    await writeFile(file, yaml);
    assert.throws(() => loadTelegramConfig(root, legacy), error => !error.message.includes('fixture-value-do-not-display'));
  }
  await rm(file);
  const other = path.join(root, 'other.yml');
  await writeFile(other, 'telegram: {}');
  if (process.platform !== 'win32') {
    await symlink(other, file);
    assert.throws(() => loadTelegramConfig(root, legacy), /regular file/);
    await rm(file);
  }
  await link(other, file);
  assert.throws(() => loadTelegramConfig(root, legacy), /unlinked/);
});

test('migration copies inherited IDs only, never credentials, and refuses to overwrite an existing file', async t => {
  const root = await mkdtemp(path.join(os.tmpdir(), 's8-config-migrate-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  await mkdir(path.join(root, 'pi/bin'), { recursive: true });
  await mkdir(path.join(root, 'pi/lib'));
  await mkdir(path.join(root, 'pi/node_modules'));
  await symlink(fileURLToPath(new URL('../node_modules/yaml', import.meta.url)), path.join(root, 'pi/node_modules/yaml'), process.platform === 'win32' ? 'junction' : 'dir');
  await copyFile(new URL('../bin/s8-config.mjs', import.meta.url), path.join(root, 'pi/bin/s8-config.mjs'));
  await copyFile(new URL('../lib/telegram-config.mjs', import.meta.url), path.join(root, 'pi/lib/telegram-config.mjs'));
  const env = { ...legacy, TELEGRAM_BOT_TOKEN: 'fixture-bot-not-for-yaml', PHCMS_ACCESS_TOKEN: 'fixture-service-not-for-yaml' };
  const cli = path.join(root, 'pi/bin/s8-config.mjs');
  const output = execFileSync(process.execPath, [cli, 'init'], { env, encoding: 'utf8' });
  const content = await readFile(path.join(root, 's8-config.yml'), 'utf8');
  for (const value of [env.TELEGRAM_BOT_TOKEN, env.PHCMS_ACCESS_TOKEN]) {
    assert.equal(content.includes(value), false);
    assert.equal(output.includes(value), false);
  }
  assert.deepEqual(loadTelegramConfig(root, {}), { allowedUserIds: ['123'], allowedGroupIds: ['-456'], scheduleChatId: '123', source: 'file' });
  assert.throws(() => execFileSync(process.execPath, [cli, 'init'], { env, stdio: 'pipe' }), error => /already exists/.test(error.stderr));
  assert.equal(await readFile(path.join(root, 's8-config.yml'), 'utf8'), content);
});

test('scheduler delivery uses the shared YAML target, never legacy IDs, and invalid config leaves no owner lock', async t => {
  if (process.platform === 'win32') return t.skip('requires Bash');
  const agent = await mkdtemp(path.join(os.tmpdir(), 's8-config-scheduler-'));
  t.after(() => rm(agent, { recursive: true, force: true }));
  const root = path.join(agent, '.s8-runtime/scheduler');
  await mkdir(path.join(root, 'scripts'), { recursive: true });
  await writeFile(path.join(agent, 's8-config.yml'), 'telegram:\n  allowedUserIds: ["789"]\n  scheduleChatId: "789"');
  await writeFile(path.join(root, 'scripts/check.sh'), 'echo config-check');
  await writeFile(path.join(root, 'jobs.json'), JSON.stringify({ version: 1, jobs: [{ id: 'check', intervalMinutes: 5, timezone: 'Asia/Seoul', enabled: true }] }));
  const sent = [];
  const options = { root, cwd: agent, env: { ...legacy, TELEGRAM_BOT_TOKEN: 'fixture-bot' }, now: () => new Date('2026-10-14T00:00:00Z'), fetchImpl: async (_url, options) => {
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

test('shared config validates worker count and public work URL without changing Telegram settings', async t => {
  const { loadS8Config } = await import('../lib/telegram-config.mjs');
  const root = await mkdtemp(path.join(os.tmpdir(), 's8-workers-config-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  assert.equal(loadS8Config(root, {}).workers.count, 2);
  const file = path.join(root, 's8-config.yml');
  await writeFile(file, 'telegram: {}\nworkers:\n  count: 3\npublicUrl: https://s8.example.invalid/s8/\n');
  assert.equal(loadS8Config(root, {}).workers.count, 3);
  assert.equal(loadS8Config(root, {}).publicUrl, 'https://s8.example.invalid/s8/');
  assert.equal(loadTelegramConfig(root, legacy).scheduleChatId, null);
  for (const count of ['0', '-1', '1.5', '"2"', '9007199254740992']) {
    await writeFile(file, `telegram: {}\nworkers:\n  count: ${count}\n`);
    assert.throws(() => loadS8Config(root, {}), /workers.count/);
  }
  for (const url of ['ftp://s8.example.invalid', 'https://user:password@s8.example.invalid', 'https://s8.example.invalid/?token=x']) {
    await writeFile(file, `telegram: {}\npublicUrl: ${url}\n`);
    assert.throws(() => loadS8Config(root, {}), /publicUrl/);
  }
});
