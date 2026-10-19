import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, writeFile, readFile, symlink, link, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { managerKb } from '../lib/manager/kb.mjs';
import manager, { MANAGER_TOOLS, MANAGER_EXTENSION_TOOLS } from '../extensions/manager.ts';
import { openManagerSession } from './helpers/manager-session.mjs';

test('KB only reads Markdown inside root and rejects hidden, symlink, hardlink and traversal paths', async t => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'manager-kb-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  await mkdir(path.join(root, 'docs'));
  await writeFile(path.join(root, 'docs/policy.md'), 'Login policy: preserve sessions.');
  await writeFile(path.join(root, 'AGENTS.md'), 'not KB content');
  await symlink(path.join(root, 'docs'), path.join(root, 'alias'));
  await writeFile(path.join(root, 'linked-original.md'), 'not searchable fixture');
  await link(path.join(root, 'linked-original.md'), path.join(root, 'hard.md'));
  const kb = managerKb(root);
  assert.match((await kb.document('docs/policy.md')).content, /Login/);
  for (const file of ['../outside.md', '.env', 'AGENTS.md', 'alias/policy.md', 'hard.md', '/etc/passwd']) await assert.rejects(kb.document(file));
  const hit = await kb.search('preserve');
  assert.equal(hit.status, 'SUCCESS');
  assert.equal(hit.matches.length, 1);
  assert.equal((await kb.search('no-result')).status, 'NO_MATCH');
  await assert.rejects(managerKb(path.join(root, 'missing')).search('query'));
});

test('manager enables general tools and rejects shell schedule mutations', async t => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'manager-role-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const previous = process.env.S8_PI_CONFIG_ROOT;
  process.env.S8_PI_CONFIG_ROOT = path.join(root, 'pi');
  t.after(() => { if (previous === undefined) delete process.env.S8_PI_CONFIG_ROOT; else process.env.S8_PI_CONFIG_ROOT = previous; });
  const tools = new Map(), handlers = new Map(), commands = [];
  let active;
  manager({ on(name, fn) { handlers.set(name, [...(handlers.get(name) ?? []), fn]); }, registerTool(tool) { tools.set(tool.name, tool); }, registerCommand(name) { commands.push(name); }, setActiveTools(names) { active = names; } });
  assert.deepEqual([...tools.keys()].sort(), [...MANAGER_EXTENSION_TOOLS].sort());
  const guard = handlers.get('tool_call').at(-1);
  for (const toolName of MANAGER_TOOLS) assert.equal(guard({ toolName }), undefined);
  assert.equal(guard({ toolName: 'unknown_tool' }).block, true);
  for (const handler of handlers.get('session_start')) handler({}, { sessionManager: { getBranch: () => [] } });
  assert.deepEqual(active, MANAGER_TOOLS);
  assert.equal(handlers.has('user_bash'), false);
  await assert.rejects(tools.get('projectman').execute('test', { action: 'intake_source', sourcePath: '/tmp/private.md' }), /cannot read source files/);
  const execute = args => tools.get('scheduler').execute('test', args, undefined, undefined, { hasUI: true, ui: { confirm: async () => true } });
  await assert.rejects(execute({ action: 'create', id: 'evil', kind: 'shell', script: 'echo evil' }), /only permits/);
  const store = path.join(root, '.s8-runtime/scheduler');
  await mkdir(store, { recursive: true });
  await writeFile(path.join(store, 'jobs.json'), JSON.stringify({ version: 1, jobs: [{ id: 'legacy', kind: 'shell' }] }));
  await assert.rejects(execute({ action: 'update', id: 'legacy', enabled: true }), /cannot change/);
  await assert.rejects(execute({ action: 'delete', id: 'legacy' }), /cannot change/);
  await execute({ action: 'create', id: 'safe', kind: 'projectman', projectUid: 'cnt_project' });
});

test('installed Pi SDK loads the manager extension without discovered packages or tools', async t => {
  const { DefaultResourceLoader, SettingsManager } = await import('@earendil-works/pi-coding-agent');
  const root = await mkdtemp(path.join(os.tmpdir(), 'manager-sdk-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const previous = process.env.S8_PI_CONFIG_ROOT;
  process.env.S8_PI_CONFIG_ROOT = path.join(root, 'pi');
  t.after(() => { if (previous === undefined) delete process.env.S8_PI_CONFIG_ROOT; else process.env.S8_PI_CONFIG_ROOT = previous; });
  const loader = new DefaultResourceLoader({ cwd: root, agentDir: root, settingsManager: SettingsManager.inMemory({ packages: [] }), noExtensions: true, noSkills: true, noPromptTemplates: true, noThemes: true, noContextFiles: true, additionalExtensionPaths: [new URL('../extensions/manager.ts', import.meta.url).pathname] });
  await loader.reload();
  const loaded = loader.getExtensions();
  assert.deepEqual(loaded.errors, []);
  assert.equal(loaded.extensions.length, 1);
  assert.deepEqual([...loaded.extensions[0].tools.keys()].sort(), [...MANAGER_EXTENSION_TOOLS].sort());
});

test('persistent manager SDK session exposes general tools alongside Projectman', async t => {
  const { ModelRuntime } = await import('@earendil-works/pi-coding-agent');
  const root = await mkdtemp(path.join(os.tmpdir(), 'manager-general-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const previous = process.env.S8_PI_CONFIG_ROOT;
  process.env.S8_PI_CONFIG_ROOT = path.join(root, 'pi');
  t.after(() => { if (previous === undefined) delete process.env.S8_PI_CONFIG_ROOT; else process.env.S8_PI_CONFIG_ROOT = previous; });
  const directory = path.join(root, 'session');
  const modelRuntime = await ModelRuntime.create({ authPath: path.join(root, 'auth.json'), modelsPath: path.join(root, 'models.json') });
  const model = { id: 'fixture', name: 'Fixture', provider: 'fixture', api: 'openai-completions', baseUrl: 'http://127.0.0.1:1', reasoning: false, input: ['text'], cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 }, contextWindow: 32768, maxTokens: 1024 };
  const session = await openManagerSession({ root: new URL('../..', import.meta.url).pathname, cwd: root, directory, modelRuntime, model, poll: false });
  await session.close();
  const [record] = (await readFile(path.join(directory, 'manager.events.jsonl'), 'utf8')).trim().split('\n').map(JSON.parse);
  assert.deepEqual([...record.tools].sort(), [...MANAGER_TOOLS].sort());
  assert.match(record.systemPrompt, /일반 대화/);
  assert.match(record.systemPrompt, /기능 구현.*Projectman work/);
});

test('KB CRUD requires policy and current document version; protected paths remain denied', async t => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'manager-kb-crud-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const kb = managerKb(root);
  await assert.rejects(kb.write('note.md', 'new', null), /policy/);
  await kb.guidelines();
  const first = await kb.write('note.md', 'first', null);
  assert.equal((await kb.document('note.md')).content, 'first');
  await assert.rejects(kb.write('note.md', 'overwrite', null), /conflict/);
  const second = await kb.write('note.md', 'second', first.version);
  await assert.rejects(kb.delete('note.md', first.version), /conflict/);
  await kb.delete('note.md', second.version);
  await assert.rejects(kb.document('note.md'));
  for (const name of ['AGENTS.md', '../outside.md', '.hidden.md', 'secret.md', 'code.js']) await assert.rejects(kb.write(name, 'bad', null));
});


test('manager records result review through the existing workflow API', async t => {
  const previous = { S8_PI_CONFIG_ROOT: process.env.S8_PI_CONFIG_ROOT, PHCMS_API_URL: process.env.PHCMS_API_URL, PHCMS_ACCESS_TOKEN: process.env.PHCMS_ACCESS_TOKEN, fetch: globalThis.fetch };
  process.env.S8_PI_CONFIG_ROOT = '/tmp/s8-review-fixture/pi';
  process.env.PHCMS_API_URL = 'http://127.0.0.1:1/api/v2'; process.env.PHCMS_ACCESS_TOKEN = 'fixture';
  t.after(() => { globalThis.fetch = previous.fetch; for (const key of ['S8_PI_CONFIG_ROOT', 'PHCMS_API_URL', 'PHCMS_ACCESS_TOKEN']) { if (previous[key] === undefined) delete process.env[key]; else process.env[key] = previous[key]; } });
  let request;
  globalThis.fetch = async (url, options) => { request = { url: String(url), body: JSON.parse(options.body) }; return Response.json({ state: 'review', workflow: { managerReview: { message: 'Verified evidence' } } }); };
  const tools = new Map();
  manager({ on() {}, registerTool(tool) { tools.set(tool.name, tool); }, registerCommand() {} }, { poll: false });
  await tools.get('projectman').execute('review', { action: 'review_result', uid: 'task-1', expectedRevision: 4, message: 'Verified evidence' });
  assert.ok(request.url.endsWith('/items/task-1/workflow'));
  assert.equal(request.body.action, 'review_result'); assert.equal(request.body.message, 'Verified evidence'); assert.equal(request.body.expectedRevision, 4);
});
