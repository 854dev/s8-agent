import test from 'node:test';
import assert from 'node:assert/strict';
import { once } from 'node:events';
import { mkdtemp, rm } from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { createProjectmanConsole } from '../lib/projectman-console.mjs';

async function fixture(t, { capabilities = async () => ({ workflowVersion: 1, actorType: 'human' }) } = {}) {
  const root = await mkdtemp(path.join(os.tmpdir(), 's8-console-'));
  const operations = [];
  const server = createProjectmanConsole({ root, authFactory: () => ({ login: async () => ({ accessToken: 'fixture.user.token', refreshToken: 'fixture.refresh.token' }) }), clientFactory: token => {
    assert.equal(token, 'fixture.user.token');
    return { capabilities, list: async () => [], workflow: async (uid, input) => { operations.push({ uid, input }); if (input.expectedRevision === 0) throw new Error('PH-CMS request failed (HTTP 409)'); return { uid, state: 'ready' }; } };
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
    [async () => ({ workflowVersion: 1, actorType: 'agent' }), 403],
  ]) {
    const { base, headers, operations } = await fixture(t, { capabilities })
    assert.equal((await fetch(`${base}/api/projectman/items?type=task`, { headers })).status, status)
    assert.equal((await fetch(`${base}/api/projectman/items/task-1/workflow`, { method: 'POST', headers, body: JSON.stringify({ action: 'authorize' }) })).status, status)
    assert.equal(operations.length, 0)
  }
})
