import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash, randomUUID } from 'node:crypto';
import { mkdtemp, mkdir, writeFile, link, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { ProjectmanClient, projectmanJson } from '../lib/projectman-client.ts';
import { captureIntakeSource, previewIntake, registerIntake, describeIntake, checkPreview } from '../lib/projectman-intake.ts';
import attach from '../extensions/projectman.ts';

const digest = text => createHash('sha256').update(text).digest('hex');
const input = () => ({ source: { label: '요청.md', text: 'KB 확장만 삭제. 경로가 충돌하면 다른 경로에 복원.' }, workspace: { title: 'PH-CMS', text: '제품' }, project: { title: 'KB', text: '구현' }, works: [{ key: 'db', title: 'DB', text: '확장 작성', acceptance: ['검증 통과'] }] });
const preview = plan => ({ plan, hash: digest(JSON.stringify(plan)), sourceHash: digest(plan.source.text), containers: { workspace: 'PH-CMS', project: 'KB' }, related: [], relatedMayBeTruncated: false });
function fixture() {
  let commits = 0, loseResponse = false;
  const bodies = [];
  const records = new Map();
  const fetcher = async (url, options = {}) => {
    assert.equal(options.headers.authorization, 'Bearer fixture-key');
    const uri = new URL(url);
    let result;
    if (uri.pathname.endsWith('/intakes/preview')) result = preview(JSON.parse(options.body));
    else if (uri.pathname.endsWith('/intakes')) {
      const { plan, hash } = JSON.parse(options.body);
      bodies.push({ plan, hash });
      if (!records.has(plan.requestId)) {
        commits++;
        records.set(plan.requestId, { requestId: plan.requestId, hash, sourceHash: digest(plan.source.text), items: [
          { key: 'workspace', uid: 'ws', type: 'workspace', parentUid: null, existing: false },
          { key: 'project', uid: 'project', type: 'project', parentUid: 'ws', existing: false },
          { key: 'work-db', uid: 'task', type: 'task', parentUid: 'project', existing: false },
        ] });
      }
      if (loseResponse) { loseResponse = false; throw new Error('fixture lost response'); }
      result = records.get(plan.requestId);
    } else if (uri.pathname.includes('/intakes/')) {
      const saved = records.get(uri.pathname.split('/').at(-1));
      if (!saved) return { ok: false, status: 404, json: async () => ({}) };
      result = { requestId: saved.requestId, hash: saved.hash, manifest: bodies.find(body => body.plan.requestId === saved.requestId).plan };
    } else if (uri.pathname.endsWith('/contents')) {
      const item = [...records.values()].flatMap(row => row.items).find(row => row.uid === uri.searchParams.get('uids'));
      result = { last: true, content: item ? [{ ...item, title: item.uid, status: 'published', created_at: '2026-01-01', updated_at: null, parent: item.parentUid ? { uid: item.parentUid } : null, detail: { text: 'spec', attributes: { state: 'todo', autorun: false, requiresApproval: true, allowedActions: [], intake: { hash: [...records.values()][0]?.hash } } } }] : [] };
    } else throw new Error(`Unexpected fixture route: ${uri.pathname}`);
    return { ok: true, json: async () => structuredClone(result) };
  };
  return { fetcher, bodies, records, get commits() { return commits; }, lose: () => { loseResponse = true; } };
}

test('intake previews are read-only, bind exact source/plan, and verify committed items without activating them', async () => {
  const f = fixture();
  const client = new ProjectmanClient('http://127.0.0.1/api', 'fixture-key', f.fetcher);
  const p = await previewIntake(client, input());
  assert.equal(f.commits, 0);
  assert.match(describeIntake(p), /autorun=false/);
  assert.match(describeIntake(p), /검증 통과/);
  const first = await registerIntake(client, p);
  assert.equal(first.items.length, 3);
  assert.deepEqual(await registerIntake(client, p), first);
  assert.equal(f.commits, 1);
  const changed = structuredClone(p); changed.plan.works[0].text = 'changed';
  assert.throws(() => checkPreview(changed), /Invalid/);
  const credentials = input(); credentials.source.text = 'TOKEN=fixture-sensitive-value';
  await assert.rejects(previewIntake(client, credentials), /credentials/);
  for (const text of ['PHCMS_ACCESS_TOKEN=fixture-sensitive-value', 'phcms_sk_fixturetokenvalue']) {
    credentials.source.text = text;
    await assert.rejects(previewIntake(client, credentials), /credentials/);
  }
  assert.equal(f.commits, 1);
  const incomplete = { ...client, registerIntake: async () => ({ ...first, items: [] }) };
  await assert.rejects(registerIntake(incomplete, p), /Incomplete/);
});

test('lost registration response never causes a new request ID; explicit retry recovers committed hierarchy', async () => {
  const f = fixture();
  const client = new ProjectmanClient('http://127.0.0.1/api', 'fixture-key', f.fetcher);
  const p = await previewIntake(client, input());
  f.lose();
  await assert.rejects(registerIntake(client, p), /lost response/);
  await registerIntake(client, p);
  assert.equal(f.commits, 1);
  assert.equal(f.bodies[0].plan.requestId, f.bodies[1].plan.requestId);
});

test('Projectman tool requires UI confirmation, restores previews on the current branch, pages source and persists cancellation', async t => {
  const f = fixture();
  const oldFetch = globalThis.fetch;
  const oldURL = process.env.PHCMS_API_URL, oldToken = process.env.PHCMS_ACCESS_TOKEN;
  globalThis.fetch = f.fetcher;
  process.env.PHCMS_API_URL = 'http://127.0.0.1/api'; process.env.PHCMS_ACCESS_TOKEN = 'fixture-key';
  t.after(() => {
    globalThis.fetch = oldFetch;
    if (oldURL === undefined) delete process.env.PHCMS_API_URL; else process.env.PHCMS_API_URL = oldURL;
    if (oldToken === undefined) delete process.env.PHCMS_ACCESS_TOKEN; else process.env.PHCMS_ACCESS_TOKEN = oldToken;
  });
  const entries = [{ type: 'message', id: 'user-request', message: { role: 'user', content: input().source.text } }];
  const setup = () => {
    let tool;
    const handlers = new Map(), commands = new Map();
    attach({ registerTool: value => { tool = value; }, registerCommand: (name, command) => commands.set(name, command), on: (name, fn) => handlers.set(name, [...handlers.get(name) ?? [], fn]), appendEntry: (customType, data) => entries.push({ type: 'custom', customType, data: structuredClone(data) }) });
    const ctx = (confirmed = true, hasUI = true) => ({ hasUI, cwd: '/fixture/854_md', sessionManager: { getBranch: () => entries }, ui: { confirm: async (_title, text) => { assert.match(text, /등록안 SHA-256/); return confirmed; } } });
    return { ctx, commands, start: async () => { for (const fn of handlers.get('session_start')) await fn({}, ctx()); }, execute: (args, context = ctx()) => tool.execute('fixture', args, new AbortController().signal, undefined, context) };
  };
  let agent = setup(); await agent.start();
  const captured = JSON.parse((await agent.execute({ action: 'intake_source', sourceLabel: '요청.md' })).content[0].text);
  const { source: _source, ...draft } = input();
  await assert.rejects(agent.execute({ action: 'intake_preview', plan: draft }), /captured sourceId/);
  const response = await agent.execute({ action: 'intake_preview', sourceId: captured.sourceId, plan: draft });
  const id = JSON.parse(response.content[0].text).requestId;
  assert.equal(captured.chunk, input().source.text);
  assert.equal(f.commits, 0);
  const chunks = await agent.execute({ action: 'intake_get', requestId: id, limit: 20 });
  assert.equal(JSON.parse(chunks.content[0].text).nextOffset, 20);
  await assert.rejects(agent.execute({ action: 'intake_register', requestId: id }, agent.ctx(true, false)), /Interactive/);
  assert.equal(f.commits, 0);
  agent = setup(); await agent.start(); // New extension instance reconstructs this branch, not unrelated session entries.
  const restoredSource = JSON.parse((await agent.execute({ action: 'intake_source', sourceId: captured.sourceId })).content[0].text);
  assert.equal(restoredSource.chunk, input().source.text);
  await agent.execute({ action: 'intake_register', requestId: id });
  assert.equal(f.commits, 1);
  assert.equal(f.bodies[0].plan.source.text, input().source.text);
  const stored = JSON.parse((await agent.execute({ action: 'intake_get', requestId: id })).content[0].text);
  assert.equal(stored.origin, 'projectman');
  await assert.rejects(agent.execute({ action: 'transition', uid: 'task', expectedState: 'todo', nextState: 'doing', event: 'started', message: 'start' }), /User confirmation required/);
  const next = JSON.parse((await agent.execute({ action: 'intake_preview', sourceId: captured.sourceId, plan: draft })).content[0].text).requestId;
  await assert.rejects(agent.execute({ action: 'intake_register', requestId: next }, agent.ctx(false)), /canceled/);
  agent = setup(); await agent.start();
  await assert.rejects(agent.execute({ action: 'intake_register', requestId: next }), /not found/);
  assert.equal(f.commits, 1);
  assert.ok(agent.commands.has('projectman-register'));
});

test('source capture preserves real Markdown/user messages instead of model-written copies, and refuses unsafe paths', async t => {
  const dev = await mkdtemp(path.join(os.tmpdir(), 's8-intake-source-'));
  t.after(() => rm(dev, { recursive: true, force: true }));
  const cwd = path.join(dev, '854_md'), repo = path.join(dev, 'repo');
  await mkdir(cwd); await mkdir(repo);
  const file = path.join(repo, 'request.md');
  const original = '\ufeff# 요청\r\n원본 유지. 변경 금지.\n';
  await writeFile(file, original);
  const source = await captureIntakeSource(cwd, [], file);
  assert.equal(source.source.text, original);
  assert.equal(source.hash, digest(original));
  assert.equal(source.source.label, 'repo/request.md');
  await link(file, path.join(repo, 'duplicate.md'));
  await assert.rejects(captureIntakeSource(cwd, [], file), /single-link/);
  await assert.rejects(captureIntakeSource(cwd, [], path.join(repo, 'private-secret.md')), /permitted/);
  await assert.rejects(captureIntakeSource(cwd, [], '/outside/request.md'));
  const messages = [
    { type: 'message', id: 'one', message: { role: 'user', content: '첫 원문' } },
    { type: 'message', id: 'model', message: { role: 'assistant', content: '만들어낸 원문' } },
    { type: 'message', id: 'two', message: { role: 'user', content: [{ type: 'text', text: '추가 결정' }] } },
  ];
  assert.equal((await captureIntakeSource(cwd, messages)).source.text, '추가 결정');
  const combined = await captureIntakeSource(cwd, messages, undefined, ['two', 'one']);
  assert.deepEqual(JSON.parse(combined.source.text).map(row => row.text), ['첫 원문', '추가 결정']);
  await assert.rejects(captureIntakeSource(cwd, messages, undefined, ['model']), /actual user/);
});

test('large source manifests stay authoritative but are omitted from ordinary lists and runner prompts', () => {
  const record = { detail: { attributes: { intake: { requestId: randomUUID(), sourceHash: 'hash', manifest: { source: { text: '원문'.repeat(32000) } } } } } };
  assert.ok(JSON.stringify(record).length > 64000);
  assert.ok(projectmanJson(record).length < 400);
  assert.equal(record.detail.attributes.intake.manifest.source.text.length, 64000);
});
