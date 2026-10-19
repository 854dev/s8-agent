import test from 'node:test';
import assert from 'node:assert/strict';
import { once } from 'node:events';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { preflightFingerprint } from '../lib/projectman/preflight.mjs';
import { createProjectmanConsole } from '../lib/projectman/console.mjs';

async function fixture(t, { capabilities = async () => ({ workflowVersion: 2, safeResourceDelete: true, cascadeResourceDelete: true, actorType: 'human' }), reviewed = false, client = {}, agent } = {}) {
  const root = await mkdtemp(path.join(os.tmpdir(), 's8-console-'));
  const operations = [];
  const workflow = { revision: 2, specHash: 'scope', spec: { plan: 'Finalized plan', decisionRefs: ['conversation:final-plan'] } };
  const item = { uid: 'task-1', title: 'Counter', detail: { text: 'Minimum zero', attributes: {} } };
  if (reviewed) item.detail.attributes.s8Preflight = { status: 'reviewed', specHash: workflow.specHash, fingerprint: preflightFingerprint(item, workflow), summary: 'Resolved scope' };
  const server = createProjectmanConsole({ root, authFactory: () => ({ login: async () => ({ accessToken: 'fixture.user.token', refreshToken: 'fixture.refresh.token' }) }), clientFactory: token => {
    assert.equal(token, 'fixture.user.token');
    return { capabilities, get: async () => item, getWorkflow: async () => ({ state: 'todo', workflow }), list: async () => [], workflow: async (uid, input) => { operations.push({ uid, input }); if (input.expectedRevision === 0) throw new Error('PH-CMS request failed (HTTP 409)'); return { uid, state: 'ready' }; }, ...client };
  }, agentClientFactory: () => { if (!agent) throw Object.assign(new Error(), { status: 503, code: 'AGENT_KEY_MISSING' }); return agent; } });
  server.listen(0, '127.0.0.1'); await once(server, 'listening');
  t.after(async () => { server.closeAllConnections(); await new Promise(resolve => server.close(resolve)); await rm(root, { recursive: true, force: true }); });
  const base = `http://127.0.0.1:${server.address().port}`;
  return { root, base, operations, headers: { cookie: 's8_projectman_session=fixture.user.token', Origin: base, 'Content-Type': 'application/json' } };
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
  const input = { action: 'authorize', expectedRevision: 0, requestId: 'fixture-request' };
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


test('resource CRUD requires a human same-origin session and deletes a tree without a title', async t => {
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
  assert.equal((await fetch(`${base}/api/projectman/items/task-1?cascade=true`, { method: 'DELETE', headers: { ...headers, Origin: 'http://evil.invalid' } })).status, 403);
  assert.equal((await fetch(`${base}/api/projectman/items/task-1`, { method: 'DELETE', headers })).status, 400);
  assert.equal((await fetch(`${base}/api/projectman/items/task-1?cascade=true`, { method: 'DELETE', headers })).status, 200);
  assert.deepEqual(writes.map(call => call[0]), ['workspace', 'create', 'edit', 'delete']);
  assert.deepEqual(writes[1].slice(1), ['ws', 'project', '프로젝트', '', [], '/tmp/repo']);
});

test('resource deletion fails closed against an older PH-CMS server', async t => {
  let deleted = false;
  const { base, headers } = await fixture(t, { capabilities: async () => ({ workflowVersion: 2, safeResourceDelete: true, actorType: 'human' }), client: { deleteResource: async () => { deleted = true; } } });
  const response = await fetch(`${base}/api/projectman/items/task-1?cascade=true`, { method: 'DELETE', headers });
  assert.equal(response.status, 503); assert.equal((await response.json()).code, 'CASCADE_DELETE_UNAVAILABLE'); assert.equal(deleted, false);
});

test('console forwards explicit human plan confirmation to the server independently of manager notes', async t => {
  for (const reviewed of [false, true]) {
    const { base, headers, operations } = await fixture(t, { reviewed });
    const response = await fetch(`${base}/api/projectman/items/task-1/workflow`, { method: 'POST', headers, body: JSON.stringify({ action: 'authorize', expectedRevision: 2 }) });
    assert.equal(response.status, 200);
    assert.equal(operations.length, 1);
  }
});


test('console completion accepts an optional review comment and keeps human completion authorization upstream', async t => {
  const calls = [];
  const { base, headers, root } = await fixture(t, { client: {
    getWorkflow: async () => ({ state: 'review', workflow: { result: { summary: 'Verified result' } } }),
    workflow: async (uid, operation) => { calls.push(operation); return { uid, state: 'done' }; },
  } });
  const input = { action: 'complete', expectedRevision: 4, requestId: '11111111-1111-4111-8111-111111111111', reviewComment: '추가 개선이 필요합니다.' };
  const send = (overrides = {}) => fetch(`${base}/api/projectman/items/task-1/workflow`, { method: 'POST', headers, body: JSON.stringify({ ...input, ...overrides }) });
  assert.equal((await send({ reviewComment: 'x'.repeat(6001) })).status, 400);
  assert.equal((await send()).status, 200);
  assert.equal(calls.length, 1); assert.equal(calls[0].reviewComment, undefined);
  assert.equal(calls[0].message, '사용자 검토의견:\n추가 개선이 필요합니다.');
  const { drainManagerInbox } = await import('../lib/manager/inbox.mjs');
  const messages = []; await drainManagerInbox(root, event => messages.push(event));
  assert.equal(messages.length, 1); assert.equal(messages[0].uid, 'task-1');
})


test('console finishes a stopped run with the agent key after the human session confirms the current run', async t => {
  // 워커 창 확인이 실제 tmux 서버를 건드리지 않도록 소켓 디렉터리를 격리한다.
  const tmux = await mkdtemp(path.join(os.tmpdir(), 's8-console-tmux-')), previous = process.env.TMUX_TMPDIR;
  process.env.TMUX_TMPDIR = tmux;
  t.after(async () => { if (previous === undefined) delete process.env.TMUX_TMPDIR; else process.env.TMUX_TMPDIR = previous; await rm(tmux, { recursive: true, force: true }); });
  const runId = '22222222-2222-4222-8222-222222222222', reports = [];
  const doing = async () => ({ state: 'doing', title: 'Counter', workflow: { revision: 7, run: { id: runId, status: 'running' } } });
  let agent = { getWorkflow: doing, workflow: async (uid, operation) => { reports.push({ uid, operation }); return { uid, state: 'blocked' }; } };
  const { base, headers } = await fixture(t, { client: { getWorkflow: doing }, get agent() { return agent; } });
  const send = input => fetch(`${base}/api/projectman/items/task-1/finish-stopped-run`, { method: 'POST', headers, body: JSON.stringify(input) });
  assert.equal((await send({ runId })).status, 400);
  assert.equal((await send({ runId, confirmStopped: true, report: {} })).status, 400);
  const changed = await send({ runId: '33333333-3333-4333-8333-333333333333', confirmStopped: true });
  assert.equal(changed.status, 409); assert.match((await changed.json()).error, /바뀌었습니다/);
  assert.equal(reports.length, 0);
  const finished = await send({ runId, confirmStopped: true });
  assert.equal(finished.status, 200); assert.deepEqual(await finished.json(), { uid: 'task-1', runId, status: 'finished', state: 'blocked' });
  assert.equal(reports.length, 1); assert.equal(reports[0].operation.action, 'report'); assert.equal(reports[0].operation.expectedRevision, 7); assert.equal(reports[0].operation.report.status, 'failed');
  agent = { getWorkflow: doing, workflow: async () => { throw new Error('PH-CMS request failed (HTTP 409)'); } };
  assert.equal((await send({ runId, confirmStopped: true })).status, 200, 'a delivered outbox is not sent again');
});

test('console finish fails closed with fixed messages when the agent key is missing or the server refuses', async t => {
  const tmux = await mkdtemp(path.join(os.tmpdir(), 's8-console-tmux-')), previous = process.env.TMUX_TMPDIR;
  process.env.TMUX_TMPDIR = tmux;
  t.after(async () => { if (previous === undefined) delete process.env.TMUX_TMPDIR; else process.env.TMUX_TMPDIR = previous; await rm(tmux, { recursive: true, force: true }); });
  const runId = '22222222-2222-4222-8222-222222222222';
  const doing = async () => ({ state: 'doing', workflow: { revision: 7, run: { id: runId, status: 'running' } } });
  const body = JSON.stringify({ runId, confirmStopped: true });
  const missing = await fixture(t, { client: { getWorkflow: doing } });
  const unavailable = await fetch(`${missing.base}/api/projectman/items/task-1/finish-stopped-run`, { method: 'POST', headers: missing.headers, body });
  assert.equal(unavailable.status, 503); assert.equal((await unavailable.json()).code, 'AGENT_KEY_MISSING');
  const refused = await fixture(t, { client: { getWorkflow: doing }, agent: { getWorkflow: doing, workflow: async () => { throw new Error('PH-CMS request failed (HTTP 409) secret body'); } } });
  const response = await fetch(`${refused.base}/api/projectman/items/task-1/finish-stopped-run`, { method: 'POST', headers: refused.headers, body });
  const result = await response.json();
  assert.equal(response.status, 409); assert.equal(result.code, 'FINISH_REFUSED'); assert.match(result.error, /거부/); assert.doesNotMatch(JSON.stringify(result), /secret/);
});

test('console lists resident workers, switches modes and queues instructions only for ready tasks', async t => {
  let task = { state: 'todo', workflow: { revision: 3 } };
  const { root, base, headers } = await fixture(t, { client: { getWorkflow: async () => task } });
  await writeFile(path.join(root, 's8-config.yml'), 'workers:\n  - id: dev-a\n    mode: passive\n');
  const status = async () => (await (await fetch(`${base}/api/projectman/workers`, { headers })).json()).workers;
  assert.deepEqual((await status()).map(({ id, mode, configMode, overridden, queue }) => ({ id, mode, configMode, overridden, queue })), [{ id: 'dev-a', mode: 'passive', configMode: 'passive', overridden: false, queue: [] }]);
  assert.equal((await fetch(`${base}/api/projectman/workers`)).status, 401);

  const mode = body => fetch(`${base}/api/projectman/workers/dev-a/mode`, { method: 'POST', headers, body: JSON.stringify(body) });
  assert.equal((await fetch(`${base}/api/projectman/workers/dev-a/mode`, { method: 'POST', headers: { ...headers, Origin: 'http://evil.invalid' }, body: '{"mode":"active"}' })).status, 403);
  assert.equal((await mode({ mode: 'busy' })).status, 400);
  assert.equal((await mode({ mode: 'active' })).status, 200);
  assert.deepEqual((await status())[0].mode, 'active');
  assert.equal((await mode({ mode: null })).status, 200);
  assert.equal((await status())[0].overridden, false);
  assert.equal((await fetch(`${base}/api/projectman/workers/dev-z/mode`, { method: 'POST', headers, body: '{"mode":"active"}' })).status, 404);

  const instruct = uid => fetch(`${base}/api/projectman/workers/dev-a/instructions`, { method: 'POST', headers, body: JSON.stringify({ uid }) });
  assert.equal((await instruct('task-1')).status, 409);
  task = { state: 'ready', workflow: { revision: 3, grant: { actorUid: 'human' }, assignment: { assignee: 'dev-b' } } };
  assert.equal((await instruct('task-1')).status, 409);
  task = { state: 'ready', workflow: { revision: 3, grant: { actorUid: 'human' } } };
  assert.equal((await instruct('../x')).status, 400);
  assert.equal((await instruct('task-1')).status, 202);
  assert.deepEqual((await status())[0].queue, ['task-1']);
});
