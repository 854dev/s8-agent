import test from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { copyFile, mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { mcpClient, parseLedger, rejectCountTask, runCount } from '../lib/projectman-count.mjs';
import { dueDate, isDue, validateJob } from '../lib/scheduler-store.mjs';

test('S8 sends its service key in MCP Authorization without exposing it in the body', async () => {
  const original = globalThis.fetch;
  const key = 'phcms_sk_' + 'A'.repeat(43);
  try {
    globalThis.fetch = async (_url, init) => {
      assert.equal(init.headers.Authorization, `Bearer ${key}`);
      assert.equal(init.body.includes(key), false);
      return new Response(JSON.stringify({ result: { content: [{ type: 'text', text: '{"ok":true}' }] } }));
    };
    assert.deepEqual(await mcpClient('http://localhost:3001/mcp', key)('phcms_list_contents', {}), { ok: true });
    await assert.rejects(mcpClient('http://localhost:3001/mcp', '')('phcms_list_contents', {}), /S8 requires/);
  } finally { globalThis.fetch = original; }
});

test('MCP client uses an inherited service key without loading a settings file', () => {
  const key = 'phcms_sk_' + 'A'.repeat(43);
  const output = execFileSync(process.execPath, ['--input-type=module', '-e', `
    import assert from 'node:assert/strict';
    import { mcpClient } from ${JSON.stringify(new URL('../lib/projectman-count.mjs', import.meta.url).href)};
    globalThis.fetch = async (_url, init) => {
      assert.equal(init.headers.Authorization, ${JSON.stringify(`Bearer ${key}`)});
      return new Response(JSON.stringify({ result: { content: [{ type: 'text', text: '{"ok":true}' }] } }));
    };
    assert.deepEqual(await mcpClient('http://localhost:3001/mcp')('phcms_list_contents', {}), { ok: true });
    console.log('authenticated');
  `], { encoding: 'utf8', env: { PHCMS_ACCESS_TOKEN: key } });
  assert.equal(output.trim(), 'authenticated');
});

test('away mode fails closed without notifications and arms a bounded window only after delivery', async t => {
  const root = await mkdtemp(path.join(os.tmpdir(), 's8-away-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  await mkdir(path.join(root, 'pi/bin'), { recursive: true });
  await mkdir(path.join(root, 'pi/lib'));
  const runtime = path.join(root, '.s8-runtime/scheduler');
  await mkdir(path.join(runtime, 'scripts'), { recursive: true });
  await copyFile(new URL('../bin/count-test.mjs', import.meta.url), path.join(root, 'pi/bin/count-test.mjs'));
  await writeFile(path.join(root, 'pi/lib/scheduler-daemon.mjs'), 'export const sendTelegram = async () => process.env.FIXTURE_NOTIFY === "yes";');
  await writeFile(path.join(root, 'pi/lib/telegram-config.mjs'), 'export const loadTelegramConfig = () => ({ allowedUserIds: ["123"], allowedGroupIds: [], scheduleChatId: "123", source: "file" });');
  await writeFile(path.join(root, 'pi/lib/projectman-count.mjs'), `
    export function mcpClient() { return async (name) => {
      if (name === 'phcms_get_content') return { type: 'project', title: 'fixture', attributes: { test: 'count-100', minimumValue: 0 } };
      if (name === 'phcms_list_contents') return { total: 3, items: [1, 2, 1000].map((subtract,index) => ({ uid: 'cnt_task' + index, attributes: { test: 'count-100', sequence: index + 1, subtract, state: 'ready', autorun: true } })) };
      if (name === 'phcms_update_content') { if (process.env.FIXTURE_FAIL === 'yes') throw new Error('Fixture API failure'); return {}; }
      throw new Error('Unexpected tool');
    }; }
    export const runCount = () => {}, rejectCountTask = () => {}, parseLedger = () => {};
  `);
  await writeFile(path.join(runtime, 'owner.lock'), `${process.pid}\nexpiresAt-v1\n`);
  const jobsFile = path.join(runtime, 'jobs.json');
  const original = JSON.stringify({ version: 1, jobs: [{ id: 'projectman-count', intervalMinutes: 30, timezone: 'Asia/Seoul', enabled: true }] });
  await writeFile(jobsFile, original);
  const run = env => execFileSync(process.execPath, [path.join(root, 'pi/bin/count-test.mjs'), 'away', 'cnt_fixture', '60'], { encoding: 'utf8', stdio: 'pipe', env: { HOME: root, ...env } });
  assert.throws(() => run({}), error => /operation was not started/.test(error.stderr));
  assert.equal(await readFile(jobsFile, 'utf8'), original);
  const result = JSON.parse(run({ FIXTURE_NOTIFY: 'yes' }));
  assert.equal(Date.parse(result.expiresAt) - Date.parse(result.startedAt), 60 * 60_000);
  const job = JSON.parse(await readFile(jobsFile, 'utf8')).jobs[0];
  assert.equal(job.intervalMinutes, 5);
  assert.equal(job.expiresAt, result.expiresAt);
  assert.equal(job.enabled, true);
  assert.throws(() => run({ FIXTURE_NOTIFY: 'yes', FIXTURE_FAIL: 'yes' }), error => /Fixture API failure/.test(error.stderr));
  assert.equal(JSON.parse(await readFile(jobsFile, 'utf8')).jobs[0].enabled, false);
});

test('30-minute slots preserve daily schedules and prevent duplicate slot runs', () => {
  const job = validateJob({ id: 'count', intervalMinutes: 30, timezone: 'Asia/Seoul', script: 'echo test' });
  const now = new Date('2026-10-14T00:30:10Z');
  assert.equal(isDue(job, now), true);
  assert.equal(isDue(job, now, dueDate(job, now).date), false);
  assert.equal(isDue(job, new Date('2026-10-14T00:31:00Z')), false);
  assert.throws(() => validateJob({ ...job, time: '09:00' }));
});

test('due times, ordered subtraction, completion recovery and repeated runs', async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), 's8-count-'));
  const file = path.join(root, 'result.txt');
  const tasks = [1, 2, 3].map(amount => ({ uid: `task-${amount}`, title: `${amount}`, attributes: { test: 'count-100', sequence: amount, subtract: amount, state: 'ready', autorun: true, scheduledAt: `2026-10-14T0${amount}:00:00Z` } }));
  let failComplete = true;
  const call = async (name, args) => {
    if (name === 'phcms_get_content') return { type: 'project', attributes: { test: 'count-100' } };
    if (name === 'phcms_list_contents') return { items: structuredClone(tasks), total: 3 };
    const task = tasks.find(task => task.uid === args.uid);
    assert.equal(task.attributes.state, args.expectedState);
    if (args.nextState === 'done' && failComplete) { failComplete = false; throw new Error('API outage'); }
    task.attributes.state = args.nextState;
  };
  try {
    await writeFile(file, '100\n');
    const run = time => runCount({ call, projectUid: 'project', file, now: new Date(time) });
    await run('2026-10-14T00:00:00Z');
    assert.equal(parseLedger(await readFile(file, 'utf8')).value, 100);
    await assert.rejects(run('2026-10-14T01:00:00Z'), /outage/);
    assert.equal(parseLedger(await readFile(file, 'utf8')).value, 99);
    await run('2026-10-14T01:00:00Z');
    assert.equal(parseLedger(await readFile(file, 'utf8')).value, 99);
    await run('2026-10-14T03:00:00Z');
    assert.equal(parseLedger(await readFile(file, 'utf8')).value, 97);
    await run('2026-10-14T03:00:00Z');
    await run('2026-10-14T03:00:00Z');
    assert.equal(parseLedger(await readFile(file, 'utf8')).value, 94);
    assert.equal(tasks.every(task => task.attributes.state === 'done'), true);
    assert.throws(() => parseLedger('100\n90\tx\t1\t2026-01-01T00:00:00Z\n'));
  } finally { await rm(root, { recursive: true, force: true }); }
});

test('minimum result blocks 1000, persists the question, and a durable rejection survives later runs', async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), 's8-count-decision-'));
  const file = path.join(root, 'result.txt');
  const project = { uid: 'project', type: 'project', attributes: { test: 'count-100', minimumValue: 0 } };
  const tasks = [1, 2, 1000].map((amount, index) => ({ uid: `task-${amount}`, type: 'task', title: `${amount} 빼기`, attributes: { test: 'count-100', sequence: index + 1, subtract: amount, state: 'ready', autorun: true, scheduledAt: '2026-10-14T00:00:00Z' } }));
  const logs = [];
  let loseRejectionResponse = true;
  const call = async (name, args) => {
    if (name === 'phcms_list_contents') return { items: structuredClone(tasks), total: 3 };
    if (name === 'phcms_get_content') return structuredClone(args.uid === 'project' ? project : tasks.find(task => task.uid === args.uid));
    assert.equal(name, 'projectman_transition_item');
    const task = tasks.find(task => task.uid === args.uid);
    assert.equal(task.attributes.state, args.expectedState);
    logs.push({ ...args });
    task.attributes.state = args.nextState;
    if (args.nextState === 'canceled' && loseRejectionResponse) { loseRejectionResponse = false; throw new Error('Decision saved but response lost'); }
  };
  try {
    await writeFile(file, '100\n');
    const run = () => runCount({ call, projectUid: 'project', file, now: new Date('2026-10-14T01:00:00Z') });
    await run(); await run();
    assert.equal(parseLedger(await readFile(file, 'utf8')).value, 97);
    assert.match(await run(), /사용자 확인 요청/);
    assert.equal(tasks[2].attributes.state, 'blocked');
    assert.match(logs.at(-1).message, /97 - 1000 = -903/);
    tasks[2].attributes.state = 'ready'; // A resume/approval must not bypass the unchanged project rule.
    assert.match(await run(), /사용자 확인 요청/);
    assert.equal(tasks[2].attributes.state, 'blocked');
    const logCount = logs.length;
    assert.match(await run(), /사용자 응답 대기/);
    assert.equal(logs.length, logCount);
    assert.equal(parseLedger(await readFile(file, 'utf8')).value, 97);
    await assert.rejects(rejectCountTask({ call, uid: 'task-1000', message: '1000 빼기는 하지 마라', file }), /response lost/);
    assert.equal(tasks[2].attributes.state, 'canceled');
    assert.equal(logs.at(-1).message, '1000 빼기는 하지 마라');
    assert.match(await rejectCountTask({ call, uid: 'task-1000', message: '1000 빼기는 하지 마라', file }), /already canceled/);
    assert.match(await run(), /finished/);
    assert.match(await run(), /finished/);
    assert.equal(parseLedger(await readFile(file, 'utf8')).value, 97);
    assert.equal(logs.filter(log => log.nextState === 'canceled').length, 1);
    assert.throws(() => parseLedger('100\n-900\ttask-1000\t1000\t2026-01-01T00:00:00Z\n'));
    await assert.rejects(rejectCountTask({ call, uid: 'task-1', message: '취소', file }), /already persisted/);
  } finally { await rm(root, { recursive: true, force: true }); }
});
