import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { once } from 'node:events';
import { randomUUID } from 'node:crypto';
import { createRequire } from 'node:module';
import { mkdtemp, mkdir, writeFile, rm } from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { createProjectmanConsole } from '../lib/projectman-console.mjs';

// Reuse PH-CMS's installed parser, not a permissive fetch/client mock. No env loader or DB is used.
// Domain/auth responses below are fixtures; full PH-CMS DB/business-policy tests remain separate.
let Fastify;
try { Fastify = createRequire(new URL('../../../ph-cms/packages/server/package.json', import.meta.url))('fastify'); } catch {}
const integration = (name, fn) => test(name, { skip: Fastify ? false : 'Install sibling ph-cms server dependencies for real Fastify HTTP regression' }, fn);
const jar = response => response.headers.getSetCookie().map(field => field.split(';')[0]).join('; ');

async function fixture(t, { requestTimeout } = {}) {
  const root = await mkdtemp(path.join(os.tmpdir(), 's8-console-http-'));
  const state = { items: new Map(), writes: 0, attempts: 0, refreshes: 0, expireRead: false, expireWrite: false, rejectFresh: false, refreshStatus: 200, reads: 0, delayWrite: 0 };
  const upstream = Fastify({ logger: false });
  const pair = suffix => ({ accessToken: `fixture.${suffix}`, refreshToken: `fixture.refresh.${suffix}` });
  upstream.post('/api/v2/auth/login', () => pair('old'));
  upstream.post('/api/v2/auth/refresh', (_req, reply) => { state.refreshes++; return reply.code(state.refreshStatus).send(state.refreshStatus === 200 ? pair('fresh') : { message: 'Fixture refresh unavailable' }); });
  upstream.get('/api/v2/projectman/capabilities', () => ({ workflowVersion: 2, actorType: 'human', safeResourceDelete: true, cascadeResourceDelete: true }));
  upstream.get('/api/v2/contents', (req, reply) => {
    state.reads++;
    assert.equal(req.query.channelSlug, 'ph-projectman');
    if (state.rejectFresh || (state.expireRead && req.headers.authorization === 'Bearer fixture.old')) return reply.code(401).send({ message: 'Expired fixture' });
    const content = [...state.items.values()].filter(item => (!req.query.uids || item.uid === req.query.uids) && (!req.query.type || item.type === req.query.type) && (!req.query.parentUid || item.parent?.uid === req.query.parentUid));
    return { content, last: true };
  });
  upstream.post('/api/v2/contents', async (req, reply) => {
    state.attempts++;
    if (state.expireWrite && req.headers.authorization === 'Bearer fixture.old') return reply.code(401).send({ message: 'Expired fixture' });
    const { type, title, text, parentUid, attributes } = req.body;
    const item = { uid: `item-${++state.writes}`, type, title, ...(parentUid ? { parent: { uid: parentUid } } : {}), detail: { text, attributes } };
    state.items.set(item.uid, item);
    if (state.delayWrite) await new Promise(resolve => setTimeout(resolve, state.delayWrite));
    return reply.code(201).send(item);
  });
  upstream.put('/api/v2/contents/:uid', (req, reply) => {
    const item = state.items.get(req.params.uid);
    if (!item) return reply.code(404).send({});
    if (req.body.title === 'frozen') return reply.code(400).send({ message: 'Delegated work is frozen; use workflow delegation to revise execution scope' });
    if (req.body.title === 'unknown-error') return reply.code(400).send({ message: 'Bearer fixture-private-error-value' });
    item.title = req.body.title; item.detail.text = req.body.text; return item;
  });
  upstream.delete('/api/v2/projectman/items/:uid/tree', (req, reply) => {
    assert.equal(req.headers['content-type'], undefined, 'Empty JSON DELETE must fail this real Fastify regression');
    state.items.delete(req.params.uid); return { uid: req.params.uid, deletedUids: [req.params.uid], deletedCount: 1, retainedLogCount: 0 };
  });
  upstream.get('/api/v2/projectman/items/:uid/workflow', req => ({ state: 'todo', workflow: null, uid: req.params.uid }));
  upstream.post('/api/v2/projectman/items/:uid/workflow', req => ({ uid: req.params.uid, state: 'ready', action: req.body.action }));
  const address = await upstream.listen({ host: '127.0.0.1', port: 0 });
  const server = createProjectmanConsole({ root, baseUrl: `${address}/api/v2`, fetchImpl: (url, init) => fetch(url, requestTimeout ? { ...init, signal: AbortSignal.any([init.signal, AbortSignal.timeout(requestTimeout)]) } : init) });
  server.listen(0, '127.0.0.1'); await once(server, 'listening');
  const base = `http://127.0.0.1:${server.address().port}`;
  t.after(async () => { server.closeAllConnections(); await new Promise(resolve => server.close(resolve)); await upstream.close(); await rm(root, { recursive: true, force: true }); });
  const headers = { Origin: base, 'Content-Type': 'application/json' };
  const login = await fetch(`${base}/api/projectman/login`, { method: 'POST', headers, body: JSON.stringify({ email: 'fixture@example.invalid', password: 'fixture' }) });
  assert.equal(login.status, 200);
  const cookie = jar(login);
  const request = (endpoint, method = 'GET', data, session = cookie) => fetch(`${base}/api/projectman${endpoint}`, { method, headers: { ...headers, cookie: session }, ...(data === undefined ? {} : { body: JSON.stringify(data) }) });
  return { state, root, base, headers: { ...headers, cookie }, request };
}

integration('real console + SDK + client + Fastify covers resource CRUD, workflow and safe errors', async t => {
  const f = await fixture(t);
  let response = await f.request('/items', 'POST', { type: 'workspace', title: '팀', text: '원문' }); assert.equal(response.status, 201);
  const ws = (await response.json()).item;
  response = await f.request('/items', 'POST', { type: 'project', title: '앱', text: '', parentUid: ws.uid, repoPath: '/tmp/repo' }); assert.equal(response.status, 201);
  const project = (await response.json()).item;
  response = await f.request('/items', 'POST', { type: 'task', title: '작업', text: '', parentUid: project.uid }); assert.equal(response.status, 201);
  const task = (await response.json()).item; assert.deepEqual(task.detail.attributes, { state: 'todo', autorun: false });
  assert.equal((await f.request('/items?type=workspace')).status, 200);
  assert.equal((await f.request(`/items/${task.uid}`)).status, 200);
  assert.equal((await f.request(`/items/${task.uid}/workflow`, 'POST', { action: 'authorize', requestId: randomUUID(), expectedRevision: 0, planHash: 'a'.repeat(64), message: '확인' })).status, 200);
  assert.equal((await f.request(`/items/${ws.uid}`, 'PATCH', { title: '수정', text: '새 본문' })).status, 200);
  response = await f.request(`/items/${ws.uid}`, 'PATCH', { title: 'frozen', text: '' });
  assert.equal(response.status, 400); assert.equal((await response.json()).code, 'WORKFLOW_FROZEN');
  response = await f.request(`/items/${ws.uid}`, 'PATCH', { title: 'unknown-error', text: '' });
  assert.equal(response.status, 400); assert.doesNotMatch(JSON.stringify(await response.json()), /fixture-private/);
  response = await f.request(`/items/${ws.uid}?cascade=true`, 'DELETE'); assert.equal(response.status, 200);
  assert.equal((await f.request(`/items/${ws.uid}`)).status, 404);
});

integration('split Korean UTF-8 and the full UI text limit survive real HTTP parsing', async t => {
  const f = await fixture(t);
  const payload = Buffer.from(JSON.stringify({ type: 'workspace', title: '가나다', text: '설명' }));
  const split = payload.indexOf(Buffer.from('가')) + 1;
  const result = await new Promise((resolve, reject) => {
    const req = http.request(`${f.base}/api/projectman/items`, { method: 'POST', headers: { ...f.headers, 'Content-Length': payload.length } }, res => {
      const chunks = []; res.on('data', chunk => chunks.push(chunk)); res.on('end', () => resolve({ status: res.statusCode, body: JSON.parse(Buffer.concat(chunks).toString()) }));
    });
    req.on('error', reject); req.write(payload.subarray(0, split)); setTimeout(() => req.end(payload.subarray(split)), 20);
  });
  assert.equal(result.status, 201); assert.equal(result.body.item.title, '가나다');
  for (const text of ['가'.repeat(50000), '\u0001'.repeat(50000)]) {
    const response = await f.request('/items', 'POST', { type: 'workspace', title: 'full limit', text });
    assert.equal(response.status, 201); assert.equal((await response.json()).item.detail.text, text);
  }
  assert.equal((await f.request('/items', 'POST', { type: 'workspace', title: 'over limit', text: 'x'.repeat(50001) })).status, 400);
  assert.equal((await fetch(`${f.base}/api/projectman/items`, { method: 'POST', headers: f.headers, body: 'x'.repeat(384001) })).status, 413);
  assert.equal((await fetch(`${f.base}/api/projectman/items`, { method: 'POST', headers: f.headers, body: Buffer.from([0xff]) })).status, 400);
});

integration('a read expiring after capability checks refreshes and retries exactly once', async t => {
  const f = await fixture(t); f.state.expireRead = true;
  const responses = await Promise.all(Array.from({ length: 6 }, () => f.request('/items?type=workspace')));
  assert.ok(responses.every(response => response.status === 200)); assert.equal(f.state.refreshes, 1); assert.match(jar(responses[0]), /fixture.fresh/);
  assert.equal(f.state.reads, 12);
  f.state.rejectFresh = true;
  assert.equal((await f.request('/items?type=workspace')).status, 401);
  assert.equal(f.state.refreshes, 1, 'The shared refresh cache is reused; no retry loop');
  assert.equal(f.state.reads, 14);
});

integration('an expired write refreshes cookies but is never automatically replayed', async t => {
  const f = await fixture(t); f.state.expireWrite = true;
  const input = { type: 'workspace', title: '한 번', text: '' };
  const rejected = await f.request('/items', 'POST', input);
  assert.equal(rejected.status, 401); assert.equal((await rejected.json()).code, 'SESSION_RENEWED');
  assert.equal(f.state.attempts, 1); assert.equal(f.state.writes, 0); assert.equal(f.state.refreshes, 1);
  assert.equal((await f.request('/items', 'POST', input, jar(rejected))).status, 201);
  assert.equal(f.state.attempts, 2); assert.equal(f.state.writes, 1);
});

integration('refresh outage preserves cookies and does not replay writes', async t => {
  const f = await fixture(t); f.state.expireWrite = true; f.state.refreshStatus = 503;
  const response = await f.request('/items', 'POST', { type: 'workspace', title: 'fixture', text: '' });
  assert.equal(response.status, 503); assert.equal(f.state.attempts, 1); assert.equal(f.state.writes, 0);
  assert.equal(response.headers.getSetCookie().length, 0);
});

integration('a timed-out write may already have committed and is not replayed', async t => {
  const f = await fixture(t, { requestTimeout: 100 }); f.state.delayWrite = 500;
  const response = await f.request('/items', 'POST', { type: 'workspace', title: 'slow write', text: '' });
  assert.equal(response.status, 503); assert.equal(f.state.attempts, 1); assert.equal(f.state.writes, 1);
  assert.equal(f.state.refreshes, 0); assert.equal(response.headers.getSetCookie().length, 0);
});

integration('event routes preserve partial tails, page large files, and still enforce authentication', async t => {
  const f = await fixture(t), id = '11111111-1111-4111-8111-111111111111';
  const directory = path.join(f.root, '.s8-runtime/runs', id); await mkdir(directory, { recursive: true });
  await writeFile(path.join(directory, 'request.json'), JSON.stringify({ task: { uid: 'fixture-task' } }));
  const events = path.join(directory, 'developer.events.jsonl'); await writeFile(events, '{"i":1}\n{"partial":');
  let response = await f.request(`/runs/${id}/events?cursor=0`); assert.equal(response.status, 200);
  const page = await response.json(); assert.deepEqual(page.events, [{ i: 1 }]); assert.ok(page.nextCursor > 0);
  const row = JSON.stringify({ text: 'x'.repeat(400000) }) + '\n'; await writeFile(events, row.repeat(30));
  response = await f.request(`/runs/${id}/events?cursor=0`); assert.equal(response.status, 200);
  const large = await response.json(); assert.equal(large.events.length, 2); assert.ok(large.nextCursor > 0);
  assert.equal((await f.request(`/runs/${id}/events?cursor=${large.nextCursor}`)).status, 200);
  assert.equal((await f.request(`/runs/${id}/events?offset=2`)).status, 200);
  assert.equal((await f.request(`/runs/${id}/events?cursor=2`)).status, 400);
  assert.equal((await f.request(`/runs/${id}/events?cursor=0`, 'GET', undefined, '')).status, 401);
});
