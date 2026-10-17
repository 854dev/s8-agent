import test from 'node:test';
import assert from 'node:assert/strict';
import { ProjectmanClient } from '../lib/projectman-client.ts';
import { hasReviewedPreflight, preflightFingerprint } from '../lib/projectman-preflight.mjs';

function fixture({ beforePut = () => {}, afterPut = () => {} } = {}) {
  const workflow = { revision: 2, specHash: 'scope-1', spec: { allowedPaths: ['src'], completionCriteria: ['Minimum zero'], commandNames: ['test'] } };
  const task = { uid: 'task-1', state: 'todo', workflow };
  const item = { uid: task.uid, title: 'Counter', type: 'task', parent: { uid: 'project-1' }, detail: { text: 'Minimum zero, no negative values', attributes: { state: 'todo', autorun: false, workflow, unrelated: 'preserved' } } };
  const writes = [];
  const client = new ProjectmanClient('http://localhost/api', 'fixture', async (url, init) => {
    const operation = init.body ? JSON.parse(init.body) : null;
    if (init.method === 'PUT') {
      beforePut({ item, task, workflow });
      // Model Projectman content rules: require unchanged state and merge attributes under the row lock.
      if (operation.attributes.state !== item.detail.attributes.state) return { ok: false, status: 409 };
      Object.assign(item.detail.attributes, operation.attributes);
      writes.push(operation);
      afterPut({ item, task, workflow });
    }
    if (init.method === 'POST') { writes.push(operation); return { ok: true, json: async () => task }; }
    return { ok: true, json: async () => String(url).includes('/workflow') ? structuredClone(task) : { content: [structuredClone(item)], last: true } };
  });
  return { client, item, task, workflow, writes };
}

test('manager preflight persists resolved decisions on the work before final authorization', async () => {
  const f = fixture();
  await assert.rejects(f.client.workflow('task-1', { action: 'authorize' }), /409/);
  assert.equal(f.writes.length, 0);
  await f.client.reviewPreflight('task-1', 2, 'User confirmed minimum zero. Developer chooses implementation. Run tests.');
  assert.equal(f.task.state, 'todo');
  assert.equal(hasReviewedPreflight(f.item, f.workflow), true);
  assert.deepEqual(Object.keys(f.writes[0].attributes).sort(), ['s8Preflight', 'state']);
  assert.equal(f.writes[0].attributes.state, 'todo');
  assert.equal(f.item.detail.attributes.autorun, false);
  assert.equal(f.item.detail.attributes.unrelated, 'preserved');
  assert.equal(f.item.detail.attributes.workflow, f.workflow);
  await f.client.workflow('task-1', { action: 'authorize', expectedRevision: 2 });
  assert.equal(f.writes.at(-1).action, 'authorize');
});

test('changed requirements, scope, title or parent invalidate the manager review', async () => {
  for (const mutate of [f => { f.item.detail.text = 'Allow negatives'; }, f => { f.workflow.spec.allowedPaths.push('test'); }, f => { f.workflow.specHash = 'scope-2'; }, f => { f.item.title = 'New counter'; }, f => { f.item.parent.uid = 'project-2'; }]) {
    const f = fixture(); await f.client.reviewPreflight('task-1', 2, 'Resolved scope'); mutate(f);
    assert.equal(hasReviewedPreflight(f.item, f.workflow), false);
    await assert.rejects(f.client.workflow('task-1', { action: 'authorize' }), /409/);
  }
});

test('review cannot complete with stale revision, pending questions, grant or missing summary', async () => {
  for (const mutate of [f => { f.workflow.revision++; }, f => { f.workflow.review = { pending: true }; }, f => { f.workflow.grant = {}; }, f => { f.task.state = 'doing'; }, f => { f.item.detail.attributes.state = 'ready'; }, f => { delete f.item.detail.attributes.state; }]) {
    const f = fixture(); mutate(f);
    await assert.rejects(f.client.reviewPreflight('task-1', 2, 'Resolved scope'), /409/);
    assert.equal(f.writes.length, 0);
  }
  await assert.rejects(fixture().client.reviewPreflight('task-1', 2, ' '), /summary required/);
});

test('concurrent transition rejects the write without restoring the old state', async () => {
  const f = fixture({ beforePut: ({ item, task }) => { item.detail.attributes.state = task.state = 'ready'; } });
  await assert.rejects(f.client.reviewPreflight('task-1', 2, 'Resolved scope'), /409/);
  assert.equal(f.writes.length, 0);
  assert.equal(f.item.detail.attributes.state, 'ready');
  assert.equal(f.item.detail.attributes.s8Preflight, undefined);
});

test('changes during saving cannot be reported as a successful preflight review', async () => {
  for (const afterPut of [
    ({ workflow }) => { workflow.revision++; },
    ({ workflow }) => { workflow.grant = {}; },
    ({ workflow }) => { workflow.review = { pending: true }; },
    ({ task }) => { task.state = 'ready'; },
    ({ item }) => { item.detail.attributes.state = 'ready'; },
    ({ item }) => { item.detail.text = 'Allow negatives'; },
    ({ workflow }) => { workflow.specHash = 'scope-2'; },
    ({ workflow }) => { workflow.spec.allowedPaths.push('test'); },
    ({ item }) => { item.detail.attributes.s8Preflight.summary = 'Another manager review'; },
    ({ item }) => { delete item.detail.attributes.s8Preflight; },
  ]) {
    const f = fixture({ afterPut });
    await assert.rejects(f.client.reviewPreflight('task-1', 2, 'Resolved scope'), /409/);
    assert.equal(f.writes.length, 1);
  }
});

test('a concurrent content edit and matching replacement review cannot masquerade as this review', async () => {
  const f = fixture({ afterPut: ({ item, workflow }) => {
    item.detail.text = 'Different requirements';
    item.detail.attributes.s8Preflight.fingerprint = preflightFingerprint(item, workflow);
  } });
  await assert.rejects(f.client.reviewPreflight('task-1', 2, 'Resolved scope'), /409/);
  assert.equal(hasReviewedPreflight(f.item, f.workflow), true);
});
