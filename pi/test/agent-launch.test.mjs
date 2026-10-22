import test from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, readFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { DefaultResourceLoader, ModelRuntime, SettingsManager, loadSkills } from '@earendil-works/pi-coding-agent';
import { loadProfile, resolveMode } from '../lib/agent/profile.mjs';
import { piArgs, validatePiOptions } from '../lib/agent/launch.mjs';

test('only the three launcher modes resolve', () => {
  assert.equal(resolveMode('general'), 'general');
  assert.equal(resolveMode('local'), null);
  assert.equal(resolveMode('manager'), 'manager');
  assert.equal(resolveMode('worker'), 'worker');
  assert.equal(resolveMode('rpc'), null);
});

test('profiles define role extension, prompt, tools, work directory and connection loading', () => {
  const general = loadProfile('general'), manager = loadProfile('manager');
  assert.deepEqual(general.tools, ['read', 'bash', 'edit', 'write', 'grep', 'find', 'ls']);
  assert.equal(general.workDir, 'cwd');
  assert.equal(general.loadEnv, true);
  assert.ok(manager.tools.includes('projectman') && manager.tools.includes('kb'));
  assert.equal(manager.workDir, 'kb');
  assert.ok(manager.extensions[0].endsWith('pi/extensions/manager.ts'));
  assert.ok(manager.systemPrompt.endsWith('agents/manager/SYSTEM.md'));
  const worker = loadProfile('worker');
  assert.deepEqual(worker.tools, ['agent_message', 'projectman', 'read', 'bash', 'edit', 'write', 'grep', 'find', 'ls']);
  assert.equal(worker.workDir, 'cwd');
  assert.equal(worker.loadEnv, true);
  assert.deepEqual(worker.extensions.map(file => file.split('/').at(-1)), ['worker.ts']);
});

test('Pi arguments load the common provider alongside profile, Telegram or control extensions', () => {
  const profile = loadProfile('general');
  const args = piArgs('/s8', profile, { sessionDir: '/s8/.pi-runtime/x' });
  for (const flag of ['--no-extensions', '--no-skills', '--no-prompt-templates', '--no-context-files']) assert.ok(args.includes(flag));
  const provider = '/s8/pi/node_modules/pi-clinepass-provider/src/index.ts';
  assert.deepEqual(args.filter((_, i) => args[i - 1] === '--extension'), [provider, ...profile.extensions]);
  for (const mode of ['general', 'manager', 'worker']) {
    for (const control of [false, true]) assert.ok(piArgs('/s8', loadProfile(mode), { control }).includes(provider));
  }
  assert.deepEqual(args.filter((_, i) => args[i - 1] === '--skill'), profile.skills);
  assert.equal(args[args.indexOf('--tools') + 1], profile.tools.join(','));
  assert.equal(args[args.indexOf('--session-dir') + 1], '/s8/.pi-runtime/x');
  assert.ok(piArgs('/s8', profile, { telegram: true }).includes('/s8/pi/extensions/telegram.mjs'));
  const control = piArgs('/s8', profile, { telegram: true, control: true });
  assert.ok(control.includes('/s8/pi/extensions/managed-session.mjs'));
  assert.ok(!control.includes('/s8/pi/extensions/telegram.mjs'));
});

test('installed Pi SDK registers ClinePass with discovery disabled and a key reference', async t => {
  const { mkdtemp, rm } = await import('node:fs/promises');
  const root = await mkdtemp(path.join(os.tmpdir(), 's8-clinepass-sdk-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  t.mock.method(globalThis, 'fetch', async () => new Response('', { status: 503 }));
  const previousEnv = process.env;
  process.env = { ...previousEnv, CLINE_API_KEY: 'fixture-clinepass-key', CLINE_API_BASE: 'https://clinepass.invalid' };
  t.after(() => { process.env = previousEnv; });
  const provider = new URL('../node_modules/pi-clinepass-provider/src/index.ts', import.meta.url).pathname;
  const loader = new DefaultResourceLoader({
    cwd: root, agentDir: root, settingsManager: SettingsManager.inMemory({ packages: [] }),
    noExtensions: true, noSkills: true, noPromptTemplates: true, noThemes: true, noContextFiles: true,
    additionalExtensionPaths: [provider],
  });
  await loader.reload();
  const loaded = loader.getExtensions();
  assert.deepEqual(loaded.errors, []);
  assert.equal(loaded.extensions.length, 1);
  const registration = loaded.runtime.pendingProviderRegistrations.find(entry => entry.name === 'clinepass');
  assert.ok(registration);
  assert.equal(registration.config.apiKey, '$CLINE_API_KEY');
  assert.equal(registration.config.api, 'openai-completions');
  assert.equal(registration.config.baseUrl, 'https://clinepass.invalid/api/v1');
  assert.ok(registration.config.models.some(model => model.id === 'cline-pass/glm-5.3'));
  assert.ok(registration.config.models.some(model => model.id === 'cline-pass/deepseek-v4.1-flash'));
  assert.equal(loaded.extensions[0].tools.size, 0);
  const runtime = await ModelRuntime.create({ authPath: path.join(root, 'auth.json'), modelsPath: null, refreshOnCreate: false });
  runtime.registerProvider(registration.name, registration.config);
  assert.equal(runtime.getError(), undefined);
  assert.ok((await runtime.getAvailable('clinepass')).some(model => model.id === 'cline-pass/glm-5.3'));
});

test('user Pi options reject permission, session, file and prompt injection', () => {
  assert.deepEqual(validatePiOptions(['--model', 'fixture', '--continue']), ['--model', 'fixture', '--continue']);
  for (const input of [['--tools', 'bash'], ['-e', 'evil.ts'], ['--session', 'old.jsonl'], ['@/tmp/file'], ['--model', '--extension'], ['--', 'prompt'], ['hello']]) {
    assert.throws(() => validatePiOptions(input), /Unsupported/);
  }
});

test('Pi loads every profile skill without diagnostics, and vendored skills keep their license and source', () => {
  const names = {};
  for (const mode of ['general', 'manager', 'worker']) {
    const { skills } = loadProfile(mode);
    const result = loadSkills({ cwd: os.tmpdir(), agentDir: path.join(os.tmpdir(), 's8-no-agent-dir'), skillPaths: skills, includeDefaults: false });
    assert.deepEqual(result.diagnostics, [], mode);
    names[mode] = result.skills.map(skill => skill.name);
    for (const directory of skills.filter(directory => directory.includes('/vendor/'))) {
      for (const file of ['LICENSE', 'SOURCE.md']) assert.ok(existsSync(path.join(directory, '..', file)), `${directory}: ${file}`);
    }
  }
  // 워커와 범용(즉석 개발)은 구현·검증 스킬, 매니저는 설계 스킬을 받는다. 커밋·서브에이전트를 지시하는 스킬은 넣지 않는다.
  assert.deepEqual(names.worker, ['projectman', 'projectman-worker', 'ponytail', 'test-driven-development', 'systematic-debugging', 'verification-before-completion', 's8-self-review']);
  assert.deepEqual(names.general, names.worker.filter(name => name !== 'projectman-worker'));
  assert.deepEqual(names.manager, ['projectman', 'projectman-manager', 's8-operations', 's8-requirements', 's8-task-plan', 's8-plan-review']);
});

test('every role replaces bash with one that hides secret environment values from the agent', async t => {
  const { registerSecretFreeBash } = await import('../extensions/secret-free-bash.ts');
  const tools = new Map();
  registerSecretFreeBash({ registerTool: tool => tools.set(tool.name, tool) }, os.tmpdir());
  const previous = { PHCMS_ACCESS_TOKEN: process.env.PHCMS_ACCESS_TOKEN, CLINE_API_KEY: process.env.CLINE_API_KEY, S8_KB_ROOT: process.env.S8_KB_ROOT };
  Object.assign(process.env, { PHCMS_ACCESS_TOKEN: 'fixture-secret-value', CLINE_API_KEY: 'fixture-clinepass-secret', S8_KB_ROOT: '/fixture/kb' });
  t.after(() => { for (const [key, value] of Object.entries(previous)) { if (value === undefined) delete process.env[key]; else process.env[key] = value; } });
  const result = await tools.get('bash').execute('call', { command: 'env' }, undefined, () => {});
  const output = result.content.map(part => part.text).join('');
  assert.ok(output.includes('S8_KB_ROOT=/fixture/kb'));
  assert.ok(!output.includes('fixture-secret-value'));
  assert.ok(!output.includes('fixture-clinepass-secret'));
  // 매니저·워커·범용 확장 모두 이 bash를 등록한다.
  for (const file of ['manager.ts', 'worker.ts', 'general.mjs']) assert.match(readFileSync(new URL(`../extensions/${file}`, import.meta.url), 'utf8'), /registerSecretFreeBash\(pi/);
});
