import test from 'node:test';
import assert from 'node:assert/strict';
import { once } from 'node:events';
import { mkdtemp, rm } from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { preflightFingerprint } from '../lib/projectman-preflight.mjs';
import { createProjectmanConsole } from '../lib/projectman-console.mjs';

async function fixture(t, { capabilities = async () => ({ workflowVersion: 2, safeResourceDelete: true, actorType: 'human' }), reviewed = false, client = {} } = {}) {
  const root = await mkdtemp(path.join(os.tmpdir(), 's8-console-'));
  const operations = [];
  const workflow = { revision: 2, specHash: 'scope', spec: { plan: 'Finalized plan', decisionRefs: ['conversation:final-plan'] } };
  const item = { uid: 'task-1', title: 'Counter', detail: { text: 'Minimum zero', attributes: {} } };
  if (reviewed) item.detail.attributes.s8Preflight = { status: 'reviewed', specHash: workflow.specHash, fingerprint: preflightFingerprint(item, workflow), summary: 'Resolved scope' };
  const server = createProjectmanConsole({ root, authFactory: () => ({ login: async () => ({ accessToken: 'fixture.user.token', refreshToken: 'fixture.refresh.token' }) }), clientFactory: token => {
    assert.equal(token, 'fixture.user.token');
    return { capabilities, get: async () => item, getWorkflow: async () => ({ state: 'todo', workflow }), list: async () => [], workflow: async (uid, input) => { operations.push({ uid, input }); if (input.expectedRevision === 0) throw new Error('PH-CMS request failed (HTTP 409)'); return { uid, state: 'ready' }; }, ...client };
  } });
  server.listen(0, '127.0.0.1'); await once(server, 'listening');
  t.after(async () => { server.closeAllConnections(); await new Promise(resolve => server.close(resolve)); await rm(root, { recursive: true, force: true }); });
  const base = `http://127.0.0.1:${server.address().port}`;
  return { base, operations, headers: { cookie: 's8_projectman_session=fixture.user.token', Origin: base, 'Content-Type': 'application/json' } };
}

test('console login keeps user JWT in HttpOnly cookie and never returns it to JS', async t => {
  const { base, headers } = await fixture(t);
  assert.equal((await fetch(`${base}/api/projectman/session`)).status, 401);
  const login = await fetch(`${base}/api/projectman/login`, { method: 'POST', headers, body: JSON.stringify({ email: 'human@example.invalid', password: 'fixture' }) });
  assert.equal(login.status, 200); assert.match(login.headers.get('set-cookie'), /HttpOnly/); assert.match(login.headers.get('set-cookie'), /SameSite=Strict/);
  assert.deepEqual(await login.json(), { authenticated: true });
  assert.equal((await fetch(`${base}/api/projectman/session`, { headers })).status, 200);
  assert.equal((await fetch(`${base}/api/projectman/session`, { headers: { cookie: `s8_projectman_session=phcms_sk_${'x'.repeat(43)}` } })).status, 401);
});

test('decisions reject cross-origin writes and propagate version conflicts without secret error details', async t => {
  const { base, headers, operations } = await fixture(t);
  const url = `${base}/api/projectman/items/task-1/workflow`;
  const input = { action: 'decide', expectedRevision: 0, requestId: 'fixture-request', answer: 'resume' };
  assert.equal((await fetch(url, { method: 'POST', headers: { ...headers, Origin: 'http://evil.invalid' }, body: JSON.stringify(input) })).status, 403);
  assert.equal(operations.length, 0);
  const conflict = await fetch(url, { method: 'POST', headers, body: JSON.stringify(input) });
  assert.equal(conflict.status, 409); assert.match((await conflict.json()).error, /새로고침/);
  const success = await fetch(url, { method: 'POST', headers, body: JSON.stringify({ ...input, expectedRevision: 1 }) }); assert.equal(success.status, 200);
  assert.equal(operations.length, 2);
  assert.equal((await fetch(url, { method: 'POST', headers, body: JSON.stringify({ action: 'claim' }) })).status, 400);
});


test('expired sessions and agent-role JWTs cannot read tasks or submit human decisions', async t => {
  for (const [capabilities, status] of [
    [async () => { throw new Error('PH-CMS request failed (HTTP 401)') }, 401],
    [async () => ({ workflowVersion: 2, actorType: 'agent' }), 403],
  ]) {
    const { base, headers, operations } = await fixture(t, { capabilities })
    assert.equal((await fetch(`${base}/api/projectman/items?type=task`, { headers })).status, status)
    assert.equal((await fetch(`${base}/api/projectman/items/task-1/workflow`, { method: 'POST', headers, body: JSON.stringify({ action: 'authorize' }) })).status, status)
    assert.equal(operations.length, 0)
  }
})


test('resource CRUD requires a human same-origin session and validates parents and delete confirmation', async t => {
  const writes = [];
  const { base, headers } = await fixture(t, { client: {
    get: async uid => ({ uid, type: uid === 'ws' ? 'workspace' : 'task', title: '정확한 제목' }),
    createWorkspace: async (...args) => { writes.push(['workspace', ...args]); return { uid: 'ws' }; },
    create: async (...args) => { writes.push(['create', ...args]); return { uid: 'new' }; },
    editResource: async (...args) => { writes.push(['edit', ...args]); return { uid: args[0] }; },
    deleteResource: async uid => { writes.push(['delete', uid]); },
  } });
  const send = (suffix, method, input, options = {}) => fetch(`${base}/api/projectman/items${suffix}`, { method, headers, body: JSON.stringify(input), ...options });
  assert.equal((await send('', 'POST', { type: 'workspace', title: '새 팀', text: '설명' }, { headers: { Origin: base } })).status, 401);
  assert.equal((await send('', 'POST', { type: 'workspace', title: '새 팀', text: '설명' }, { headers: { ...headers, Origin: 'http://evil.invalid' } })).status, 403);
  assert.equal((await send('', 'POST', { type: 'workspace', title: '새 팀', text: '설명' })).status, 201);
  assert.equal((await send('', 'POST', { type: 'project', title: '프로젝트', text: '', parentUid: 'ws', repoPath: '/tmp/repo' })).status, 201);
  assert.equal((await send('', 'POST', { type: 'task', title: '작업', text: '', parentUid: 'ws' })).status, 400);
  assert.equal((await send('', 'POST', { type: 'workspace', title: '위조', text: '', attributes: { workflow: {} } })).status, 400);
  assert.equal((await send('/task-1', 'PATCH', { title: '수정', text: '본문' })).status, 200);
  assert.equal((await send('/task-1', 'PATCH', { title: '수정', text: '', attributes: {} })).status, 400);
  assert.equal((await send('/task-1', 'DELETE', { title: '다른 제목' })).status, 409);
  assert.equal((await send('/task-1', 'DELETE', { title: '정확한 제목' })).status, 200);
  assert.deepEqual(writes.map(call => call[0]), ['workspace', 'create', 'edit', 'delete']);
  assert.deepEqual(writes[1].slice(1), ['ws', 'project', '프로젝트', '', [], '/tmp/repo']);
});

test('resource deletion fails closed against an older PH-CMS server', async t => {
  let deleted = false;
  const { base, headers } = await fixture(t, { capabilities: async () => ({ workflowVersion: 2, actorType: 'human' }), client: { deleteResource: async () => { deleted = true; } } });
  const response = await fetch(`${base}/api/projectman/items/task-1`, { method: 'DELETE', headers, body: JSON.stringify({ title: 'Counter' }) });
  assert.equal(response.status, 503); assert.equal(deleted, false);
});

test('console forwards explicit human plan confirmation to the server independently of manager notes', async t => {
  for (const reviewed of [false, true]) {
    const { base, headers, operations } = await fixture(t, { reviewed });
    const response = await fetch(`${base}/api/projectman/items/task-1/workflow`, { method: 'POST', headers, body: JSON.stringify({ action: 'authorize', expectedRevision: 2 }) });
    assert.equal(response.status, 200);
    assert.equal(operations.length, 1);
  }
});
