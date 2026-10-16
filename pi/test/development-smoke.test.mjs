import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm, symlink, mkdir, writeFile, readFile } from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { createSmokeRun, smokeWorkspace, validateManifest, verifyCounter, SMOKE_DEPENDENCIES, SMOKE_DEV_DEPENDENCIES, SMOKE_IMAGE } from '../lib/development-smoke.mjs';

const manifest = () => ({ private: true, type: 'module', dependencies: SMOKE_DEPENDENCIES, devDependencies: SMOKE_DEV_DEPENDENCIES, scripts: { build: 'vite build' } });

test('smoke manifest excludes install hooks, arbitrary packages and executable script injection', () => {
  assert.ok(validateManifest(JSON.stringify(manifest())));
  for (const change of [ { dependencies: { ...SMOKE_DEPENDENCIES, malicious: 'latest' } }, { scripts: { postinstall: 'echo bad' } }, { scripts: { build: 'curl example.com' } }, { bin: './run.js' } ]) assert.throws(() => validateManifest(JSON.stringify({ ...manifest(), ...change })));
});

test('fresh smoke workspace stores request and denies external, protected, checks and symlink writes', async t => {
  const root = await mkdtemp(path.join(os.tmpdir(), 's8-smoke-test-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const run = await createSmokeRun(root, '카운터 만들기');
  const ws = smokeWorkspace(run.workspace);
  assert.equal(JSON.parse(await readFile(path.join(run.directory, 'request.json'), 'utf8')).productionProjectman, false);
  await ws.write('src/App.jsx', 'export default function App() {}');
  assert.match((await ws.read('src/App.jsx')).content, /function App/);
  for (const file of ['../elsewhere.md', '.env', '.s8-checks/counter.test.jsx', 'agents/manager/SYSTEM.md', '/tmp/source.jsx']) await assert.rejects(ws.write(file, 'bad'));
  await rm(path.join(run.workspace, 'src'), { recursive: true });
  await mkdir(path.join(root, 'outside'));
  await symlink(path.join(root, 'outside'), path.join(run.workspace, 'src'));
  await assert.rejects(ws.write('src/App.jsx', 'bad'), /links/);
});

test('verification uses isolated fixed commands, disables install scripts and removes container after failure', async t => {
  const root = await mkdtemp(path.join(os.tmpdir(), 's8-checks-test-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const run = await createSmokeRun(root, 'counter');
  await smokeWorkspace(run.workspace).write('package.json', JSON.stringify(manifest()));
  const calls = [];
  const result = await verifyCounter({ ...run, command: async (binary, args) => {
    calls.push({ binary, args });
    return { ok: args.includes('install'), exitCode: args.includes('install') ? 0 : 1, output: 'fixture' };
  } });
  assert.equal(result.ok, false);
  assert.deepEqual(result.results.map(result => result.stage), ['install', 'test']);
  assert.ok(calls[0].args.includes('--ignore-scripts'));
  assert.ok(calls[0].args.includes(SMOKE_IMAGE));
  assert.ok(calls[1].args.includes('none'));
  assert.ok(calls[1].args.includes('--read-only'));
  assert.ok(calls[1].args.includes('ALL'));
  assert.ok(calls[1].args.some(arg => arg.endsWith('target=/work/.s8-checks,readonly')));
  assert.deepEqual(calls.at(-1).args, ['rm', '-f', `s8-smoke-${run.runId}`]);
});
