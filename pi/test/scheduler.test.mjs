import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import os from 'node:os';
import path from 'node:path';
import { isDue, validateJob } from '../lib/scheduler/store.mjs';
import { runScheduler, sendTelegram } from '../lib/scheduler/daemon.mjs';
import { controlSchedules } from '../lib/scheduler/control.mjs';

// 실제 s8-config.yml을 읽지 않도록 Telegram 설정은 항상 주입한다.
const telegram = { allowedUserIds: ['123'], allowedGroupIds: [], scheduleChatId: '123' };
const job = { id: 'morning', time: '09:00', timezone: 'Asia/Seoul', enabled: true, script: 'echo hello' };

test('validates daily jobs and only runs once per local date/time', () => {
  assert.equal(validateJob(job).id, 'morning');
  const due = new Date('2026-02-03T00:00:00Z'); // 09:00 in Seoul
  assert.equal(isDue(job, due, null), true);
  assert.equal(isDue(job, due, '2026-02-03'), false);
  assert.equal(isDue({ ...job, enabled: false }, due, null), false);
  assert.throws(() => validateJob({ ...job, id: '../escape' }), /id/);
  assert.throws(() => validateJob({ ...job, time: '9:00' }), /HH:mm/);
  assert.throws(() => validateJob({ ...job, timezone: 'not-a-timezone' }), /IANA/);
  const bounded = validateJob({ ...job, time: undefined, intervalMinutes: 5, expiresAt: '2026-02-03T01:00:00Z' });
  assert.equal(isDue(bounded, new Date('2026-02-03T00:55:00Z')), true);
  assert.equal(isDue(bounded, new Date(bounded.expiresAt)), false);
  assert.equal(isDue(bounded, new Date('2026-02-03T01:05:00Z')), false);
  assert.throws(() => validateJob({ ...job, expiresAt: '2026-02-03T01:00:00' }), /explicit timezone/);
});

test('runs a due script once and persists status without retaining its output', async t => {
  if (process.platform === 'win32') return t.skip('requires Bash; Windows runtime uses Git Bash');
  const temp = await mkdtemp(path.join(os.tmpdir(), 's8-scheduler-'));
  const root = path.join(temp, 'scheduler');
  const scripts = path.join(root, 'scripts');
  await mkdir(scripts, { recursive: true });
  await writeFile(path.join(root, 'jobs.json'), JSON.stringify({ version: 1, jobs: [{ id: job.id, time: job.time, timezone: job.timezone, enabled: true }] }));
  await writeFile(path.join(scripts, 'morning.sh'), 'printf scheduler-check');
  const results = [];
  const options = { root, cwd: temp, env: {}, now: () => new Date('2026-02-03T00:00:00Z'), onResult: value => results.push(value) };
  try {
    let stop = await runScheduler(options);
    await stop();
    const state = JSON.parse(await readFile(path.join(root, 'state.json'), 'utf8'));
    assert.equal(state.jobs.morning.result, 'success');
    assert.match(results[0], /scheduler-check/);
    results.length = 0;
    stop = await runScheduler(options);
    await stop();
    assert.equal(results.length, 0);
    assert.match(await controlSchedules(root), /morning.*success/);
    await controlSchedules(root, 'pause', 'morning');
    assert.equal(JSON.parse(await readFile(path.join(root, 'jobs.json'), 'utf8')).jobs[0].enabled, false);
    await controlSchedules(root, 'resume', 'morning');
    assert.equal(JSON.parse(await readFile(path.join(root, 'jobs.json'), 'utf8')).jobs[0].enabled, true);
    await assert.rejects(controlSchedules(root, 'stop', 'morning'), /실행 중/);
  } finally { await rm(temp, { recursive: true, force: true }); }
});

test('SIGHUP shuts down the scheduler and releases its owner lock', async t => {
  if (process.platform === 'win32') return t.skip('SIGHUP is unavailable on Windows');
  const root = await mkdtemp(path.join(os.tmpdir(), 's8-scheduler-hangup-'));
  const lockFile = path.join(root, 'owner.lock');
  await writeFile(path.join(root, 'jobs.json'), JSON.stringify({ version: 1, jobs: [] }));
  const moduleUrl = new URL('../lib/scheduler/daemon.mjs', import.meta.url).href;
  const child = spawn(process.execPath, [
    '--input-type=module',
    '-e',
    `import { runScheduler } from ${JSON.stringify(moduleUrl)}; await runScheduler({ root: ${JSON.stringify(root)}, env: {} }); console.log('ready');`,
  ], { stdio: ['ignore', 'pipe', 'pipe'] });
  let stderr = '';
  child.stderr.setEncoding('utf8').on('data', chunk => { stderr += chunk; });
  t.after(async () => {
    if (child.exitCode === null && child.signalCode === null) child.kill('SIGKILL');
    await rm(root, { recursive: true, force: true });
  });

  let output = '';
  await new Promise((resolve, reject) => {
    const timeout = setTimeout(() => reject(new Error(`scheduler did not start: ${stderr}`)), 5000);
    child.once('error', reject);
    child.stdout.setEncoding('utf8').on('data', chunk => {
      output += chunk;
      if (output.includes('ready')) {
        clearTimeout(timeout);
        resolve();
      }
    });
  });
  assert.equal((await readFile(lockFile, 'utf8')).split('\n')[0], String(child.pid));
  child.kill('SIGHUP');
  const [code, signal] = await once(child, 'exit');
  assert.equal(code, 0, stderr);
  assert.equal(signal, null);
  await assert.rejects(readFile(lockFile), { code: 'ENOENT' });
});

test('expired jobs never start; a running batch is stopped at the operation deadline', async t => {
  if (process.platform === 'win32') return t.skip('requires Bash');
  const root = await mkdtemp(path.join(os.tmpdir(), 's8-operation-window-'));
  await mkdir(path.join(root, 'scripts'));
  await writeFile(path.join(root, 'scripts/window.sh'), 'sleep 2; touch must-not-run');
  const base = Date.parse('2026-02-03T00:00:00Z');
  const expiresAt = new Date(base + 150).toISOString();
  await writeFile(path.join(root, 'jobs.json'), JSON.stringify({ version: 1, jobs: [{ id: 'window', intervalMinutes: 5, timezone: 'Asia/Seoul', enabled: true, expiresAt }] }));
  const results = [];
  try {
    let stop = await runScheduler({ root, cwd: root, env: {}, now: () => new Date(base + 150), onResult: text => results.push(text) });
    await stop();
    assert.equal(results.length, 0);
    await assert.rejects(readFile(path.join(root, 'state.json')), { code: 'ENOENT' });
    const started = Date.now();
    stop = await runScheduler({ root, cwd: root, env: {}, now: () => new Date(base + Date.now() - started), onResult: text => results.push(text) });
    await stop();
    assert.match(results[0], /operation window ended/);
    assert.equal(JSON.parse(await readFile(path.join(root, 'state.json'))).jobs.window.result, 'failed');
    await assert.rejects(readFile(path.join(root, 'must-not-run')), { code: 'ENOENT' });
    assert.match(await controlSchedules(root), /기간 종료/);
    await assert.rejects(controlSchedules(root, 'resume', 'window'), /운영 기간이 끝났습니다/);
  } finally { await rm(root, { recursive: true, force: true }); }
});

test('scheduled notifications require an explicitly allowed Telegram target', async () => {
  const env = { TELEGRAM_BOT_TOKEN: 'fixture-bot' };
  assert.equal(await sendTelegram('check', {}, () => assert.fail('No token must not send'), telegram), false);
  assert.equal(await sendTelegram('check', env, () => assert.fail('No target must not send'), { ...telegram, scheduleChatId: null }), false);
  await assert.rejects(sendTelegram('check', env, () => assert.fail('Unauthorized target must not send'), { ...telegram, scheduleChatId: '456' }), /allowed/);
  assert.equal(await sendTelegram('check', env, async (_url, options) => {
    assert.deepEqual(JSON.parse(options.body), { chat_id: '123', text: 'check' });
    return { ok: true, json: async () => ({ ok: true }) };
  }, telegram), true);
});

test('Telegram retries transient failures up to three attempts but never retries a permanent rejection', async () => {
  const env = { TELEGRAM_BOT_TOKEN: 'fixture-bot' };
  let attempts = 0;
  assert.equal(await sendTelegram('check', env, async () => {
    attempts++;
    if (attempts === 1) throw new TypeError('fetch failed');
    if (attempts === 2) return { ok: false, status: 503, json: async () => ({ ok: false, error_code: 503 }) };
    return { ok: true, json: async () => ({ ok: true }) };
  }, telegram), true);
  assert.equal(attempts, 3);
  attempts = 0;
  await assert.rejects(sendTelegram('check', env, async () => {
    attempts++;
    return { ok: false, status: 403, json: async () => ({ ok: false, error_code: 403 }) };
  }, telegram), /HTTP 403/);
  assert.equal(attempts, 1);
  attempts = 0;
  await assert.rejects(sendTelegram('check', env, async () => { attempts++; throw new TypeError('fetch failed'); }, telegram), /fetch failed/);
  assert.equal(attempts, 3);
});

test('execution success never hides failed delivery; status is safe and a restart never repeats subtraction', async t => {
  if (process.platform === 'win32') return t.skip('requires Bash');
  const temp = await mkdtemp(path.join(os.tmpdir(), 's8-delivery-status-'));
  t.after(() => rm(temp, { recursive: true, force: true }));
  const root = path.join(temp, 'scheduler');
  await mkdir(path.join(root, 'scripts'), { recursive: true });
  await writeFile(path.join(root, 'jobs.json'), JSON.stringify({ version: 1, jobs: [{ id: job.id, time: job.time, timezone: job.timezone, enabled: true }] }));
  await writeFile(path.join(root, 'scripts/morning.sh'), 'printf x >> batch-count.txt; echo fixture-output-do-not-persist');
  await writeFile(path.join(root, 'state.json'), JSON.stringify({ version: 1, jobs: { morning: { lastRunDate: '2026-02-02', notificationStatus: 'sent', notifiedAt: '2026-02-02T00:00:00Z' } } }));
  const results = [];
  let attempts = 0;
  const options = { root, cwd: temp, env: { TELEGRAM_BOT_TOKEN: 'fixture-bot' }, telegramSettings: telegram, now: () => new Date('2026-02-03T00:00:00Z'), onResult: value => results.push(value), fetchImpl: async () => {
    attempts++;
    const current = JSON.parse(await readFile(path.join(root, 'state.json'), 'utf8')).jobs.morning;
    assert.equal(current.notificationStatus, 'pending');
    assert.equal(current.notifiedAt, undefined);
    return { ok: false, status: 403, json: async () => ({ ok: false, error_code: 403, description: 'fixture-sensitive-error-do-not-store' }) };
  } };
  let stop = await runScheduler(options);
  await stop();
  const text = await readFile(path.join(root, 'state.json'), 'utf8');
  const state = JSON.parse(text).jobs.morning;
  assert.equal(state.result, 'success');
  assert.equal(state.notificationStatus, 'failed');
  assert.equal(state.notificationError, 'http_403');
  assert.equal(text.includes('fixture-sensitive-error-do-not-store'), false);
  assert.equal(text.includes('fixture-output-do-not-persist'), false);
  assert.match(results[0], /Telegram 알림 실패: http_403/);
  assert.match(await controlSchedules(root), /실행 success · 알림 failed/);
  stop = await runScheduler(options);
  await stop();
  assert.equal(attempts, 1);
  assert.equal(await readFile(path.join(temp, 'batch-count.txt'), 'utf8'), 'x');
});

test('Projectman jobs poll every five minutes, stay silent when idle, and notify only dispatch/result', async t => {
  const temp = await mkdtemp(path.join(os.tmpdir(), 's8-dispatch-job-'));
  t.after(() => rm(temp, { recursive: true, force: true }));
  const root = path.join(temp, '.s8-runtime/scheduler');
  await mkdir(root, { recursive: true });
  await writeFile(path.join(root, 'jobs.json'), JSON.stringify({ version: 1, jobs: [{ id: 'work', kind: 'projectman', projectUid: 'cnt_project', intervalMinutes: 5, timezone: 'Asia/Seoul', enabled: true }] }));
  assert.throws(() => validateJob({ id: 'work', kind: 'projectman', projectUid: 'cnt_project', intervalMinutes: 10, timezone: 'Asia/Seoul' }), /intervalMinutes=5/);
  const sent = [], output = [];
  let active = false, polls = 0, completePoll;
  const options = { root, cwd: temp, env: { S8_PI_BINARY: 'fake-pi', S8_PI_CONFIG_ROOT: path.join(temp, 'pi'), TELEGRAM_BOT_TOKEN: 'fixture-bot' }, telegramSettings: telegram,
    onResult: text => output.push(text), fetchImpl: async (_url, options) => { sent.push(JSON.parse(options.body)); return { ok: true, json: async () => ({ ok: true }) }; },
    projectmanTurn: async ({ notify }) => {
      polls++;
      if (active) {
        await notify({ stage: 'start', uid: 'cnt_task', message: 'work-start' });
        await notify({ stage: 'finish', uid: 'cnt_task', message: 'work-result' });
      }
      completePoll();
      return { status: active ? 'review' : 'idle' };
    },
  };
  for (const [index, activate] of [false, true, false].entries()) {
    active = activate;
    options.now = () => new Date(Date.parse('2026-02-03T00:00:00Z') + index * 5 * 60000);
    const completed = new Promise(resolve => { completePoll = resolve; });
    const stop = await runScheduler(options);
    try { await completed; } finally { await stop(); }
    const state = JSON.parse(await readFile(path.join(root, 'state.json'), 'utf8')).jobs.work;
    assert.equal(state.result, activate ? 'review' : 'idle');
    assert.equal(state.notificationStatus, index === 0 ? 'not_needed' : 'sent');
  }
  assert.equal(polls, 3);
  assert.deepEqual(sent.map(message => message.text), ['work-start', 'work-result']);
  assert.equal(output.length, 0);
  assert.match(await controlSchedules(root), /실행 idle · 알림 sent/);
});
