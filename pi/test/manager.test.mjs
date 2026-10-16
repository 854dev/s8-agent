import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, writeFile, symlink, link, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { managerArgs } from '../lib/manager-launch.mjs';
import { managerKb } from '../lib/manager-kb.mjs';
import manager, { MANAGER_TOOLS } from '../extensions/manager.ts';

test('manager launch disables discovery and rejects permission/session/file injection', () => {
  const args = managerArgs('/s8', ['--model', 'fixture', '--continue']);
  for (const flag of ['--no-extensions', '--no-skills', '--no-prompt-templates', '--no-context-files']) assert.ok(args.includes(flag));
  assert.equal(args[args.indexOf('--tools') + 1], 'projectman,kb,scheduler');
  for (const input of [['--tools', 'bash'], ['-e', 'evil.ts'], ['--session', 'old.jsonl'], ['@/tmp/file'], ['--model', '--extension'], ['--', 'prompt']]) assert.throws(() => managerArgs('/s8', input), /Unsupported/);
});

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

test('manager exposes three tools, omits autopilot, blocks shell and rejects shell schedule mutations', async t => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'manager-role-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const previous = process.env.S8_PI_CONFIG_ROOT;
  process.env.S8_PI_CONFIG_ROOT = path.join(root, 'pi');
  t.after(() => { if (previous === undefined) delete process.env.S8_PI_CONFIG_ROOT; else process.env.S8_PI_CONFIG_ROOT = previous; });
  const tools = new Map(), handlers = new Map(), commands = [];
  let active;
  manager({ on(name, fn) { handlers.set(name, [...(handlers.get(name) ?? []), fn]); }, registerTool(tool) { tools.set(tool.name, tool); }, registerCommand(name) { commands.push(name); }, setActiveTools(names) { active = names; } });
  assert.deepEqual([...tools.keys()].sort(), [...MANAGER_TOOLS].sort());
  assert.ok(!commands.includes('autopilot'));
  const guard = handlers.get('tool_call').at(-1);
  assert.equal(guard({ toolName: 'bash' }).block, true);
  assert.equal(guard({ toolName: 'write' }).block, true);
  assert.equal(guard({ toolName: 'projectman' }), undefined);
  for (const handler of handlers.get('session_start')) handler({}, { sessionManager: { getBranch: () => [] } });
  assert.deepEqual(active, MANAGER_TOOLS);
  assert.equal((await handlers.get('user_bash')[0]()).result.exitCode, 1);
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
  assert.deepEqual([...loaded.extensions[0].tools.keys()].sort(), [...MANAGER_TOOLS].sort());
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
