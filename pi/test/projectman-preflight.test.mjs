import test from 'node:test';
import assert from 'node:assert/strict';
import { ProjectmanClient } from '../lib/projectman-client.ts';
import { hasReviewedPreflight } from '../lib/projectman-preflight.mjs';

function fixture() {
  const workflow = { revision: 2, specHash: 'scope-1', spec: { allowedPaths: ['src'], completionCriteria: ['Minimum zero'], commandNames: ['test'] } };
  const task = { uid: 'task-1', state: 'todo', workflow };
  const item = { uid: task.uid, title: 'Counter', type: 'task', parent: { uid: 'project-1' }, detail: { text: 'Minimum zero, no negative values', attributes: {} } };
  const writes = [];
  const client = new ProjectmanClient('http://localhost/api', 'fixture', async (url, init) => {
    const operation = init.body ? JSON.parse(init.body) : null;
    if (init.method === 'PUT') { Object.assign(item.detail.attributes, operation.attributes); writes.push(operation); }
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
  assert.equal(Object.keys(f.writes[0].attributes).join(), 's8Preflight');
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
  for (const mutate of [f => { f.workflow.revision++; }, f => { f.workflow.review = { pending: true }; }, f => { f.workflow.grant = {}; }, f => { f.task.state = 'doing'; }]) {
    const f = fixture(); mutate(f);
    await assert.rejects(f.client.reviewPreflight('task-1', 2, 'Resolved scope'), /409/);
    assert.equal(f.writes.length, 0);
  }
  await assert.rejects(fixture().client.reviewPreflight('task-1', 2, ' '), /summary required/);
});
