import assert from 'node:assert/strict';
import { test } from 'node:test';
import { ProjectmanClient } from '../lib/projectman-client.ts';

const item = (uid, type = 'task') => ({ uid, type, title: uid, status: 'published', created_at: '2026-01-01T00:00:00Z', updated_at: null, detail: { text: '', attributes: { state: 'ready' } } });
const response = (data, status = 200) => ({ ok: status < 400, status, json: async () => data });

test('scopes and pages content queries without exposing credentials', async () => {
  const calls = [];
  const client = new ProjectmanClient('https://cms.example/api/v2', 'secret', async (url, init) => {
    calls.push({ url: new URL(url), init });
    return response({ content: [item(`t${calls.length}`)], last: calls.length === 2 });
  });
  const tasks = await client.list('task', 'project-1', { state: 'ready' });
  assert.deepEqual(tasks.map(task => task.uid), ['t1', 't2']);
  assert.equal(calls[0].url.pathname, '/api/v2/contents');
  assert.equal(calls[0].url.searchParams.get('channelSlug'), 'ph-projectman');
  assert.equal(calls[0].url.searchParams.get('parentUid'), 'project-1');
  assert.equal(calls[1].url.searchParams.get('page'), '2');
  assert.equal(calls[0].init.headers.authorization, 'Bearer secret');
});

test('refuses an item outside the projectman channel', async () => {
  const client = new ProjectmanClient('https://cms.example/api', 'token', async () => response({ content: [], last: true }));
  await assert.rejects(client.get('other-channel-task'), /not found/);
});

test('creates a non-autonomous task and transitions via the atomic endpoint', async () => {
  const calls = [];
  const client = new ProjectmanClient('http://127.0.0.1:8000/api/v2', 'token', async (url, init) => {
    calls.push({ url: new URL(url), body: JSON.parse(init.body) });
    return response(item('created'));
  });
  await client.create('project-1', 'task', 'Feature', 'Acceptance criteria', ['kind:feature']);
  assert.deepEqual(calls[0].body.attributes, { state: 'todo', autorun: false });
  assert.equal(calls[0].body.parentUid, 'project-1');
  await client.transition('created', 'todo', 'ready', 'Planned', 'updated', '9ba3ed43-5282-4b52-b034-cb07bbbf721a');
  assert.equal(calls[1].url.pathname, '/api/v2/projectman/items/created/transitions');
  assert.equal(calls[1].body.requestId, '9ba3ed43-5282-4b52-b034-cb07bbbf721a');
  assert.equal(calls[1].body.nextState, 'ready');
});

test('creates missing phase subtasks and skips existing phases on rerun', async () => {
  const created = [];
  const client = new ProjectmanClient('https://cms.example/api', 'token', async (url, init) => {
    const parsed = new URL(url);
    if (init.method === 'POST') {
      const payload = JSON.parse(init.body);
      created.push(payload);
      return response(item(`sub-${created.length}`, 'subtask'));
    }
    if (parsed.searchParams.get('uids')) return response({ content: [item('task-1')], last: true });
    return response({ content: created.map((payload, i) => ({ ...item(`sub-${i + 1}`, 'subtask'), detail: { text: '', attributes: payload.attributes } })), last: true });
  });
  assert.equal((await client.ensurePhases('task-1')).created.length, 6);
  assert.equal((await client.ensurePhases('task-1')).created.length, 0);
  assert.ok(created.every(payload => payload.attributes.timeBudgetMinutes === 20 && payload.attributes.autorun === false));
});

test('resumes from parent and subtask logs', async () => {
  const urls = [];
  const client = new ProjectmanClient('https://cms.example/api', 'token', async url => {
    const parsed = new URL(url);
    urls.push(parsed);
    if (parsed.searchParams.get('uids') === 'task-1') return response({ content: [item('task-1')], last: true });
    if (parsed.searchParams.get('type') === 'subtask') return response({ content: [item('sub-1', 'subtask')], last: true });
    return response({ content: [item(`log-${parsed.searchParams.get('parentUid')}`, 'work_log')], last: true });
  });
  const snapshot = await client.resume('task-1');
  assert.deepEqual(snapshot.subtasks.map(s => s.uid), ['sub-1']);
  assert.deepEqual(snapshot.logs.map(s => s.uid), ['log-task-1']);
  assert.deepEqual(snapshot.subtaskLogs[0].logs.map(s => s.uid), ['log-sub-1']);
  assert.equal(urls[0].searchParams.get('withParent'), 'true');
});

test('rejects insecure non-loopback and redacts API response', async () => {
  assert.throws(() => new ProjectmanClient('http://cms.example/api', 'token'), /HTTPS/);
  const client = new ProjectmanClient('https://cms.example/api', 'token', async () => response({ message: 'sensitive' }, 403));
  await assert.rejects(client.list('task'), error => error.message === 'PH-CMS request failed (HTTP 403)');
});
