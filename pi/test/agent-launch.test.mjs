import test from 'node:test';
import assert from 'node:assert/strict';
import { loadProfile, resolveMode } from '../lib/agent/profile.mjs';
import { piArgs, validatePiOptions } from '../lib/agent/launch.mjs';

test('modes resolve with legacy aliases and unknown modes are rejected', () => {
  assert.equal(resolveMode(), 'general');
  assert.equal(resolveMode('local'), 'general');
  assert.equal(resolveMode('project'), 'manager');
  assert.equal(resolveMode('manager'), 'manager');
  assert.equal(resolveMode('worker'), 'worker');
  assert.equal(resolveMode('rpc'), null);
});

test('profiles define role extension, prompt, tools, work directory and connection loading', () => {
  const general = loadProfile('general'), manager = loadProfile('manager');
  assert.deepEqual(general.tools, ['read', 'bash', 'edit', 'write', 'grep', 'find', 'ls']);
  assert.equal(general.workDir, 'cwd');
  assert.equal(general.loadEnv, false);
  assert.ok(manager.tools.includes('projectman') && manager.tools.includes('kb'));
  assert.equal(manager.workDir, 'kb');
  assert.ok(manager.extensions[0].endsWith('pi/extensions/manager.ts'));
  assert.ok(manager.systemPrompt.endsWith('agents/manager/SYSTEM.md'));
  const worker = loadProfile('worker');
  assert.deepEqual(worker.tools, ['projectman', 'read', 'bash', 'edit', 'write', 'grep', 'find', 'ls']);
  assert.equal(worker.workDir, 'cwd');
  assert.equal(worker.loadEnv, true);
  assert.deepEqual(worker.extensions.map(file => file.split('/').at(-1)), ['worker.ts', 's8-guard.ts']);
});

test('Pi arguments disable discovery and load only profile, Telegram or control extensions', () => {
  const profile = loadProfile('general');
  const args = piArgs('/s8', profile, { sessionDir: '/s8/.pi-runtime/x' });
  for (const flag of ['--no-extensions', '--no-skills', '--no-prompt-templates', '--no-context-files']) assert.ok(args.includes(flag));
  assert.deepEqual(args.filter((_, i) => args[i - 1] === '--extension'), profile.extensions);
  assert.equal(args[args.indexOf('--tools') + 1], profile.tools.join(','));
  assert.equal(args[args.indexOf('--session-dir') + 1], '/s8/.pi-runtime/x');
  assert.ok(piArgs('/s8', profile, { telegram: true }).includes('/s8/pi/extensions/telegram.mjs'));
  const control = piArgs('/s8', profile, { telegram: true, control: true });
  assert.ok(control.includes('/s8/pi/extensions/managed-session.mjs'));
  assert.ok(!control.includes('/s8/pi/extensions/telegram.mjs'));
});

test('user Pi options reject permission, session, file and prompt injection', () => {
  assert.deepEqual(validatePiOptions(['--model', 'fixture', '--continue']), ['--model', 'fixture', '--continue']);
  for (const input of [['--tools', 'bash'], ['-e', 'evil.ts'], ['--session', 'old.jsonl'], ['@/tmp/file'], ['--model', '--extension'], ['--', 'prompt'], ['hello']]) {
    assert.throws(() => validatePiOptions(input), /Unsupported/);
  }
});
