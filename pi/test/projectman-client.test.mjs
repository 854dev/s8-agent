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

test('human resource writes preserve attributes and use the channel-scoped tree endpoint', async () => {
  const calls = [];
  const client = new ProjectmanClient('https://cms.example/api', 'fixture-token', async (url, init) => {
    calls.push({ path: new URL(url).pathname, init });
    if (init.method === 'DELETE') {
      assert.equal(init.body, undefined);
      assert.equal(init.headers['content-type'], undefined, 'Fastify rejects empty JSON bodies before authentication');
      return response({ uid: 'ws', deletedUids: ['ws'], deletedCount: 1, retainedLogCount: 0 });
    }
    if (init.method) { assert.equal(init.headers['content-type'], 'application/json'); return response(item('ws', 'workspace')); }
    return response({ content: [item('ws', 'workspace')], last: true });
  });
  await client.createWorkspace('팀', '본문');
  assert.equal(JSON.parse(calls[0].init.body).type, 'workspace');
  await client.editResource('ws', '수정', '새 본문');
  assert.deepEqual(JSON.parse(calls[2].init.body), { title: '수정', text: '새 본문' });
  await client.deleteResource('ws');
  assert.equal(calls.at(-1).init.method, 'DELETE');
  assert.equal(calls.at(-1).path, '/api/projectman/items/ws/tree');
  const outsider = new ProjectmanClient('https://cms.example/api', 'fixture-token', async (_url, init) => init.method === 'DELETE' ? response({}, 404) : response({ content: [], last: true }));
  await assert.rejects(outsider.deleteResource('other'), /404/);
  await assert.rejects(outsider.editResource('other', 'title', 'text'), /404/);
});

test('creates a non-autonomous task without enabling execution', async () => {
  const calls = [];
  const client = new ProjectmanClient('http://127.0.0.1:8000/api/v2', 'token', async (url, init) => {
    calls.push({ url: new URL(url), body: JSON.parse(init.body) });
    return response(item('created'));
  });
  await client.create('project-1', 'task', 'Feature', 'Acceptance criteria', ['kind:feature']);
  assert.deepEqual(calls[0].body.attributes, { state: 'todo', autorun: false });
  assert.equal(calls[0].body.parentUid, 'project-1');
});

test('creation requires an existing parent and a repository path for projects', async () => {
  const client = new ProjectmanClient('https://cms.example/api', 'token', async () => { assert.fail('No requests expected'); });
  await assert.rejects(client.create(undefined, 'workspace', 'Organization', ''), /cannot create workspaces/);
  await assert.rejects(client.create('ws', 'project', 'Code', ''), /repoPath/);
});

test('sets or clears scheduledAt without replacing unrelated attributes', async () => {
  const writes = [];
  const client = new ProjectmanClient('https://cms.example/api', 'fixture-token', async (_url, init) => {
    if (init.method === 'PUT') { writes.push(JSON.parse(init.body)); return response(item('task-1')); }
    return response({ content: [item('task-1')], last: true });
  });
  await client.schedule('task-1', '2026-10-14T09:00:00+09:00');
  assert.deepEqual(writes[0], { attributes: { state: 'ready', scheduledAt: '2026-10-14T00:00:00.000Z' } });
  await client.schedule('task-1', null);
  assert.equal(writes[1].attributes.scheduledAt, null);
  await assert.rejects(client.schedule('task-1', '2026-10-14T09:00:00'), /timezone/);
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

test('known upstream rejections become fixed codes without forwarding messages or payloads', async () => {
  for (const [message, code] of [
    ['Delegated work is frozen; use workflow delegation to revise execution scope', 'WORKFLOW_FROZEN'],
    ['Delete child resources first', 'CHILD_RESOURCES_EXIST'],
    ['Finish or stop workflow execution before deleting', 'EXECUTION_NOT_FINISHED'],
    ['Projectman parent was deleted', 'PARENT_CHANGED'],
    ['Project for this codebase already exists in this workspace', 'PROJECT_ALREADY_EXISTS'],
    ["Body cannot be empty when content-type is set to 'application/json'", 'JSON_BODY_REQUIRED'],
    ['Bearer fixture-private-detail', undefined],
  ]) {
    const client = new ProjectmanClient('https://cms.example/api', 'fixture', async () => response({ message, detail: 'fixture-private-detail' }, 400));
    await assert.rejects(client.list('workspace'), error => error.status === 400 && error.code === code && error.message === 'PH-CMS request failed (HTTP 400)' && !JSON.stringify(error).includes('fixture-private-detail'));
  }
});

test('rejects insecure non-loopback and redacts API response', async () => {
  assert.throws(() => new ProjectmanClient('http://cms.example/api', 'token'), /HTTPS/);
  const client = new ProjectmanClient('https://cms.example/api', 'token', async () => response({ message: 'sensitive' }, 403));
  await assert.rejects(client.list('task'), error => error.message === 'PH-CMS request failed (HTTP 403)');
});
