import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { mcpClient, parseLedger, runCount } from '../lib/projectman-count.mjs';
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
