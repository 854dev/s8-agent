import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { once } from 'node:events';
import { mkdtemp, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { createProjectmanConsole } from '../lib/projectman-console.mjs';

async function listen(server) { server.listen(0, '127.0.0.1'); await once(server, 'listening'); return `http://127.0.0.1:${server.address().port}`; }
async function close(server) { server.closeAllConnections(); await new Promise(resolve => server.close(resolve)); }
function jar(response) { return response.headers.getSetCookie().map(field => field.split(';')[0]).join('; '); }
async function fixture(t) {
  const root = await mkdtemp(path.join(os.tmpdir(), 's8-sdk-session-'));
  const state = { generation: 0, expired: new Set(), refreshCount: 0, actions: [], refreshStatus: 200, releaseRefresh: null, refreshStarted: null, agent: false };
  const upstream = http.createServer(async (req, res) => {
    let text = ''; for await (const data of req) text += data;
    const input = text ? JSON.parse(text) : null;
    const send = (code, body) => { res.writeHead(code, { 'Content-Type': 'application/json' }); res.end(JSON.stringify(body)); };
    const pair = () => ({ accessToken: `fixture.access.${state.generation}`, refreshToken: `fixture.refresh.${state.generation}` });
    if (req.url === '/api/v2/auth/login') { assert.equal(input.email, 'person@example.invalid'); return send(200, pair()); }
    if (req.url === '/api/v2/auth/refresh') {
      state.refreshCount++;
      assert.match(input.refreshToken, /^fixture\.refresh\.\d+$/);
      if (state.refreshStarted) state.refreshStarted();
      if (state.releaseRefresh) await state.releaseRefresh;
      else await new Promise(resolve => setTimeout(resolve, 20));
      if (state.refreshStatus !== 200) return send(state.refreshStatus, { message: 'Fixture refresh failed' });
      state.generation++; return send(200, pair());
    }
    const token = req.headers.authorization?.replace('Bearer ', '');
    if (!token || state.expired.has(token)) return send(401, { message: 'Expired fixture access' });
    if (req.url === '/api/v2/projectman/capabilities') { if (state.capStarted) state.capStarted(); if (state.capGate) await state.capGate; return send(200, { workflowVersion: 1, actorType: state.agent ? 'agent' : 'human' }); }
    if (req.url.startsWith('/api/v2/contents?')) return send(200, { content: [], last: true });
    if (req.url.endsWith('/workflow')) { state.actions.push(input); return send(200, { uid: 'task-1', state: 'ready' }); }
    return send(404, {});
  });
  const upstreamUrl = await listen(upstream);
  let server = createProjectmanConsole({ root, baseUrl: `${upstreamUrl}/api/v2` });
  let base = await listen(server);
  t.after(async () => { await close(server); await close(upstream); await rm(root, { recursive: true, force: true }); });
  return {
    state,
    async request(endpoint, cookie, input) { return fetch(`${base}/api/projectman${endpoint}`, { method: input ? 'POST' : 'GET', headers: { Origin: base, cookie: cookie ?? '', 'Content-Type': 'application/json' }, ...(input ? { body: JSON.stringify(input) } : {}) }); },
    async restart() { await close(server); server = createProjectmanConsole({ root, baseUrl: `${upstreamUrl}/api/v2` }); base = await listen(server); },
  };
}
const login = f => f.request('/login', '', { email: 'person@example.invalid', password: 'isolated-fixture-password' });

test('actual client-sdk login persists both tokens in HttpOnly cookies and hides them from browser JS', async t => {
  const f = await fixture(t), response = await login(f);
  assert.equal(response.status, 200);
  const cookies = response.headers.getSetCookie(); assert.equal(cookies.length, 2);
  assert.ok(cookies.every(cookie => cookie.includes('HttpOnly') && cookie.includes('SameSite=Strict') && cookie.includes('Path=/api/projectman')));
  assert.match(cookies.find(cookie => cookie.startsWith('s8_projectman_session=')), /Max-Age=900/);
  assert.match(cookies.find(cookie => cookie.startsWith('s8_projectman_refresh=')), /Max-Age=604800/);
  assert.deepEqual(await response.json(), { authenticated: true });
  assert.equal((await f.request('/session', jar(response))).status, 200);
});

test('parallel requests refresh expired access once, and a human decision executes only once', async t => {
  const f = await fixture(t), cookie = jar(await login(f)); f.state.expired.add('fixture.access.0');
  const responses = await Promise.all(Array.from({ length: 6 }, () => f.request('/session', cookie)));
  assert.ok(responses.every(response => response.status === 200)); assert.equal(f.state.refreshCount, 1);
  const decision = { action: 'decide', expectedRevision: 5, requestId: 'same-human-decision', reviewId: 'review-1', decision: 'resume', answer: 'Continue' };
  const response = await f.request('/items/task-1/workflow', cookie, decision);
  assert.equal(response.status, 200); assert.deepEqual(f.state.actions, [decision]); assert.equal(f.state.refreshCount, 1);
});

test('refresh cookie alone restores login after access cookie expiry and console restart', async t => {
  const f = await fixture(t), response = await login(f);
  const refreshOnly = jar(response).split('; ').filter(cookie => cookie.startsWith('s8_projectman_refresh=')).join('; ');
  await f.restart(); const restored = await f.request('/session', refreshOnly);
  assert.equal(restored.status, 200); assert.equal(f.state.refreshCount, 1);
  assert.match(jar(restored), /s8_projectman_session=fixture.access.1/);
});

test('invalid refresh clears both cookies, temporary upstream failure preserves login, and logout clears both', async t => {
  for (const status of [401, 503]) {
    const f = await fixture(t), cookie = jar(await login(f)); f.state.expired.add('fixture.access.0'); f.state.refreshStatus = status;
    const response = await f.request('/session', cookie); assert.equal(response.status, status);
    if (status === 401) { assert.equal(response.headers.getSetCookie().length, 2); assert.ok(response.headers.getSetCookie().every(cookie => cookie.includes('Max-Age=0'))); }
    else assert.equal(response.headers.getSetCookie().length, 0);
    const loggedOut = await f.request('/logout', cookie, {}); assert.equal(loggedOut.status, 200); assert.ok(loggedOut.headers.getSetCookie().every(cookie => cookie.includes('Max-Age=0')));
  }
});

test('logout during an in-flight refresh prevents that request restoring a session', async t => {
  const f = await fixture(t), cookie = jar(await login(f)); f.state.expired.add('fixture.access.0');
  let release; f.state.releaseRefresh = new Promise(resolve => { release = resolve; });
  let started; const refreshing = new Promise(resolve => { started = resolve; }); f.state.refreshStarted = started;
  const pending = f.request('/session', cookie); await refreshing;
  const logout = await f.request('/logout', cookie, {}); assert.equal(logout.status, 200);
  release(); const response = await pending; assert.equal(response.status, 401); assert.ok(response.headers.getSetCookie().every(cookie => cookie.includes('Max-Age=0')));
});

test('agent accounts cannot establish a human login session', async t => {
  const f = await fixture(t); f.state.agent = true;
  const response = await login(f); assert.equal(response.status, 403); assert.equal(response.headers.getSetCookie().length, 0);
});


test('logout also wins when refreshed access is still being checked upstream', async t => {
  const f = await fixture(t), cookie = jar(await login(f)); f.state.expired.add('fixture.access.0');
  let release; f.state.capGate = new Promise(resolve => { release = resolve; });
  let started; const checking = new Promise(resolve => { started = resolve; }); f.state.capStarted = started;
  const pending = f.request('/session', cookie); await checking;
  assert.equal((await f.request('/logout', cookie, {})).status, 200);
  release(); const response = await pending; assert.equal(response.status, 401); assert.ok(response.headers.getSetCookie().every(cookie => cookie.includes('Max-Age=0')));
});
