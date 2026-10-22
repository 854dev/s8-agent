import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { randomUUID } from 'node:crypto';
import path from 'node:path';
import os from 'node:os';
import { recordFinishedRuns } from '../lib/manager/run-results.mjs';
import { drainManagerInbox, enqueueManagerMessage } from '../lib/manager/inbox.mjs';
import { flushDevelopmentOutbox } from '../lib/development/outbox.mjs';

const settings = { publicUrl: 'https://s8.example.invalid/s8/', telegram: { scheduleChatId: '123' } };
const report = { status: 'completed', summary: 'Remote work done', verification: [{ name: 'unit', ok: true }] };
const item = (runId, finishedAt, extra = {}) => ({ uid: 'task1', title: 'Remote task', detail: { attributes: { state: 'review', workflow: { run: { id: runId, status: 'finished', finishedAt }, result: report, ...extra } } } });

async function fixture(t) {
  const root = await mkdtemp(path.join(os.tmpdir(), 's8-run-results-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const sent = [];
  const record = (items, now = new Date()) => recordFinishedRuns({ root, items, settings, now: () => now, notify: async message => { sent.push(message); return true; } });
  const drained = async () => { const reports = []; await drainManagerInbox(root, value => reports.push(value)); return reports; };
  return { root, sent, record, drained };
}

test('a remote run found in Projectman reaches the manager inbox and Telegram once', async t => {
  const f = await fixture(t);
  const old = randomUUID(), runId = randomUUID();
  // The first poll only sets the starting point; runs finished before it are history.
  assert.deepEqual(await f.record([item(old, '2026-01-01T00:00:00.000Z')], new Date('2026-10-22T00:00:00.000Z')), []);
  assert.deepEqual(await f.record([item(old, '2026-01-01T00:00:00.000Z'), item(runId, '2026-10-22T01:00:00.000Z')]), [runId]);
  assert.deepEqual(await f.record([item(runId, '2026-10-22T01:00:00.000Z')]), []);
  assert.equal(f.sent.length, 1);
  assert.match(f.sent[0], new RegExp(`task=task1&run=${runId}`));
  const [delivered] = await f.drained();
  assert.deepEqual([delivered.uid, delivered.runId, delivered.state, delivered.summary, delivered.source], ['task1', runId, 'review', 'Remote work done', 'projectman']);
});

test('running, unreported and malformed runs are ignored', async t => {
  const f = await fixture(t);
  await f.record([], new Date('2026-10-22T00:00:00.000Z'));
  const later = '2026-10-22T01:00:00.000Z';
  const running = item(randomUUID(), later); running.detail.attributes.workflow.run.status = 'running';
  const unreported = item(randomUUID(), later); delete unreported.detail.attributes.workflow.result;
  assert.deepEqual(await f.record([running, unreported, item('../escape', later), { uid: 'empty' }]), []);
  assert.equal(f.sent.length, 0);
});

test('a report already queued by a worker on this machine is not repeated', async t => {
  const f = await fixture(t);
  await f.record([], new Date('2026-10-22T00:00:00.000Z'));
  const runId = randomUUID();
  await enqueueManagerMessage(f.root, runId, { uid: 'task1', runId, state: 'review', summary: 'Local work done' });
  assert.deepEqual(await f.record([item(runId, '2026-10-22T01:00:00.000Z')]), []);
  assert.equal(f.sent.length, 0);
  assert.equal((await f.drained())[0].summary, 'Local work done');
});

test('a worker on this machine leaves Telegram to a manager that queued the run first', async t => {
  const f = await fixture(t);
  await f.record([], new Date('2026-10-22T00:00:00.000Z'));
  const runId = randomUUID();
  const directory = path.join(f.root, '.s8-runtime/runs', runId);
  await mkdir(directory, { recursive: true });
  await writeFile(path.join(directory, 'outbox.json'), JSON.stringify({ version: 2, uid: 'task1', title: 'Remote task', runId, report, operation: { action: 'report', requestId: randomUUID(), runId, report } }));
  // Projectman accepted the report and the manager saw it before the worker queued its own message.
  await f.record([item(runId, '2026-10-22T01:00:00.000Z')]);
  const notices = [];
  await flushDevelopmentOutbox({ root: f.root, client: { workflow: async () => ({ state: 'review' }) }, settings, notify: async message => { notices.push(message); return true; } });
  const outbox = JSON.parse(await readFile(path.join(directory, 'outbox.json'), 'utf8'));
  assert.deepEqual([outbox.delivered, outbox.managerDelivered, outbox.telegramDelivered, outbox.notificationStatus], [true, true, true, 'manager']);
  assert.equal(notices.length, 0);
  assert.equal(f.sent.length, 1);
});
