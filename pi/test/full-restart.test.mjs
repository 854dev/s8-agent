import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, readFile, writeFile, rm, access } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { runFullRestart, waitForInfrastructure, notifyFullRestart, runInfrastructure } from '../lib/runtime/full-restart.mjs';

async function fixture(t) {
  const root = await mkdtemp(path.join(os.tmpdir(), 's8-full-restart-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const directory = path.join(root, '.s8-runtime/runtime-restarts/test');
  await mkdir(directory, { recursive: true });
  const events = [], stopped = new Set();
  const options = { '@s8-runtime-root': root, '@s8-mode': 'project', '@s8-cwd': root, '@s8-telegram': 'take', '@s8-pi-args': '["--model","fixture"]' };
  const run = async args => {
    if (args[0] === 'show-option') return { stdout: options[args.at(-1)] ?? '' };
    if (args[0] === 'list-windows' && args.includes('-a')) return { stdout: `s8-work\tscheduler\t${root}\ns8-work\tsupervisor\t${root}\ns8-other\tscheduler\t/other-checkout` };
    if (args[0] === 'list-windows') return { stdout: ['scheduler', 'supervisor'].map(name => `@${name}\t${name}\t${root}\t${stopped.has(name) ? '1' : '0'}`).join('\n') };
    if (args[0] === 'send-keys') { const name = args[2].slice(1); stopped.add(name); events.push(`stop:${name}`); }
    return { stdout: '' };
  };
  const deps = { run, infra: async () => { events.push('infra'); }, ready: async () => { events.push('ready'); }, runtime: async (_root, options) => { events.push('pi'); assert.equal(options.session, 's8-work'); assert.equal(options.telegram, true); assert.deepEqual(options.args, ['--model', 'fixture', '--continue']); return { session: options.session }; } };
  return { root, directory, events, deps, options };
}

test('full restart stops shared workers, starts infra, waits for readiness then replaces the current Pi', async t => {
  const f = await fixture(t);
  const result = await runFullRestart(`${f.root}/`, { session: 's8-work', directory: f.directory }, f.deps);
  assert.equal(result.session, 's8-work');
  assert.deepEqual(f.events, ['stop:scheduler', 'stop:supervisor', 'infra', 'ready', 'pi']);
  assert.equal(JSON.parse(await readFile(path.join(f.directory, 'progress.json'))).stage, 'completed');
  await assert.rejects(access(path.join(f.root, '.s8-runtime/runtime-restarts/all.lock')), { code: 'ENOENT' });
});

test('infra failure preserves the Telegram Pi, reports the failed stage and allows retry', async t => {
  const f = await fixture(t);
  await assert.rejects(runFullRestart(f.root, { session: 's8-work', directory: f.directory }, { ...f.deps, infra: async () => { throw new Error('private infrastructure output'); } }), error => /infra/.test(error.message) && !/private/.test(error.message));
  assert.ok(!f.events.includes('pi'));
  assert.equal(JSON.parse(await readFile(path.join(f.directory, 'progress.json'))).stage, 'infra');
  assert.equal((await runFullRestart(f.root, { session: 's8-work', directory: f.directory }, f.deps)).session, 's8-work');
});

test('duplicate full restarts are rejected before they can touch infra', async t => {
  const f = await fixture(t);
  await writeFile(path.join(f.root, '.s8-runtime/runtime-restarts/all.lock'), JSON.stringify({ pid: process.pid }));
  await assert.rejects(runFullRestart(f.root, { session: 's8-work', directory: f.directory }, f.deps), /already running/);
  assert.deepEqual(f.events, []);
});

test('readiness requires router, frontend, console, terminal and configured Projectman API', async () => {
  const calls = [];
  const env = { PHCMS_API_URL: 'http://localhost:8000/api/v2', PHCMS_ACCESS_TOKEN: 'fixture-token' };
  await waitForInfrastructure({ env, timeoutMs: 0, fetchImpl: async (url, options) => { calls.push({ url, options }); return { status: url.includes('/session') ? 401 : 200 }; } });
  assert.equal(calls.length, 5);
  assert.equal(calls.find(call => call.url.includes('/capabilities')).options.headers.authorization, 'Bearer fixture-token');
  await assert.rejects(waitForInfrastructure({ env: {}, timeoutMs: 0, fetchImpl: async () => ({ status: 503 }) }), /readiness timeout/);
});

test('infrastructure runner uses a fixed script and completion notifications preserve the Telegram topic', async t => {
  const f = await fixture(t);
  await writeFile(path.join(f.root, 'start-infra.sh'), 'exit 0\n');
  await runInfrastructure(f.root);
  const calls = [];
  assert.equal(await notifyFullRestart({ chat: -100, thread: 7 }, 'Restart complete', { token: 'fixture-token', fetchImpl: async (_url, options) => { calls.push(JSON.parse(options.body)); return { ok: true, json: async () => ({ ok: true }) }; } }), true);
  assert.deepEqual(calls, [{ chat_id: -100, message_thread_id: 7, text: 'Restart complete' }]);
  assert.equal(await notifyFullRestart({ chat: 1 }, 'Failed', { token: 'fixture-token', fetchImpl: async () => { throw new Error('offline'); } }), false);
});

test('local full restart leaves project infrastructure and services untouched', async t => {
  const f = await fixture(t);
  f.options['@s8-mode'] = 'local';
  await runFullRestart(f.root, { session: 's8-work', directory: f.directory }, { ...f.deps, runtime: async (_root, options) => {
    assert.equal(options.mode, 'local');
    assert.equal(options.cwd, f.root);
    f.events.push('local-pi');
  } });
  assert.deepEqual(f.events, ['local-pi']);
});
