import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { pickReadyTask, queueInstruction, residentTick, setWorkerMode, workerStatuses } from '../lib/agent/resident.mjs';

const ready = (uid, workflow = {}, state = 'ready') => ({ uid, detail: { attributes: { state, workflow: { revision: 1, grant: { actorUid: 'human' }, ...workflow } } } });

async function fixture(t, items = []) {
  const root = await mkdtemp(path.join(os.tmpdir(), 's8-resident-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const started = [], alive = new Set(), logs = [];
  const deps = {
    client: { list: async type => items.filter(item => (item.type ?? 'task') === type) },
    start: async uid => { if (uid === 'broken') throw new Error('not ready'); started.push(uid); alive.add(uid); return { target: `s8-workers:${uid}` }; },
    taskAlive: async uid => alive.has(uid),
    log: line => logs.push(line),
  };
  const state = async id => JSON.parse(await readFile(path.join(root, '.s8-runtime/workers', id, 'state.json'), 'utf8'));
  return { root, deps, started, alive, logs, state };
}

test('ready task selection respects assignment, dependencies, runs and skipped revisions', () => {
  const items = [
    ready('other', { assignment: { assignee: 'dev-b' } }),
    ready('blocked', { spec: { dependsOn: ['dep'] } }), ready('dep', {}, 'doing'),
    ready('running', { run: { id: 'r' } }), ready('question', { review: { pending: true } }),
    ready('skipped'), ready('mine', { assignment: { assignee: 'dev-a' } }),
  ];
  assert.deepEqual(pickReadyTask(items, 'dev-a', new Set(['skipped:1'])), { uid: 'mine', revision: 1 });
  assert.equal(pickReadyTask([ready('free')], 'dev-a').uid, 'free');
  assert.equal(pickReadyTask([ready('todo', {}, 'todo')], 'dev-a'), null);
});

test('passive workers wait for instructions, take one task at a time and move on after the report', async t => {
  const { root, deps, started, alive, state } = await fixture(t, [ready('task-a')]);
  const worker = { id: 'dev-a', mode: 'passive' };
  await residentTick(root, worker, deps);
  assert.deepEqual(started, []);
  await queueInstruction(root, 'dev-a', 'task-b', 'console');
  await queueInstruction(root, 'dev-a', 'task-c', 'manager');
  await residentTick(root, worker, deps);
  assert.deepEqual(started, ['task-b']);
  assert.equal((await state('dev-a')).current.uid, 'task-b');
  await residentTick(root, worker, deps);
  assert.deepEqual(started, ['task-b'], 'busy worker does not take the next instruction');

  // 워커가 보고하면 창이 살아 있어도 다음 지시로 넘어간다.
  await mkdir(path.join(root, '.s8-runtime/worker-claims'), { recursive: true });
  await writeFile(path.join(root, '.s8-runtime/worker-claims/task-b.json'), JSON.stringify({ uid: 'task-b', reported: true }));
  await residentTick(root, worker, deps);
  assert.deepEqual(started, ['task-b', 'task-c']);
  assert.deepEqual((await state('dev-a')).lastFinished.uid, 'task-b');

  // 보고 없이 창이 닫혀도 다음으로 넘어가고 기록을 남긴다.
  alive.delete('task-c');
  await residentTick(root, worker, deps);
  assert.deepEqual((await state('dev-a')).lastFinished, { ...(await state('dev-a')).lastFinished, uid: 'task-c', reported: false });
  assert.equal((await state('dev-a')).current, null);
});

test('active workers poll ready tasks, paused workers take nothing, and failed starts are not retried', async t => {
  const { root, deps, started, alive, state } = await fixture(t, [ready('broken'), ready('task-a')]);
  const worker = { id: 'dev-a', mode: 'active' };
  await setWorkerMode(root, 'dev-a', 'paused');
  await queueInstruction(root, 'dev-a', 'task-z', 'console');
  await residentTick(root, worker, deps);
  assert.deepEqual(started, []);
  assert.deepEqual((await workerStatuses(root, [worker]))[0].queue, ['task-z'], 'paused keeps instructions');

  await setWorkerMode(root, 'dev-a', null);
  await residentTick(root, worker, deps);
  assert.deepEqual(started, ['task-z'], 'instructions come before polling');
  alive.clear();
  const skip = new Set();
  await residentTick(root, worker, { ...deps, skip });
  assert.equal((await state('dev-a')).lastError.uid, 'broken');
  await residentTick(root, worker, { ...deps, skip });
  assert.deepEqual(started, ['task-z', 'task-a']);
  const [status] = await workerStatuses(root, [worker]);
  assert.equal(status.mode, 'active'); assert.equal(status.running, true); assert.equal(status.current.uid, 'task-a');
});
