import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, writeFile, rm } from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import net from 'node:net';
import { randomUUID } from 'node:crypto';
import { startWorkerCommunicator } from '../lib/development/worker-communicator.mjs';
import { startDeveloperWorker } from '../lib/development/worker-daemon.mjs';
import { workerRequest } from '../lib/development/worker-pool.mjs';
import { getWorkerState, enqueueWorkerMessage, readWorkerMessages } from '../lib/development/worker-store.mjs';
import { recoverDevelopmentRuns } from '../lib/development/supervisor.mjs';

const delay = ms => new Promise(resolve => setTimeout(resolve, ms));
async function until(check) {
  for (let i = 0; i < 300; i++) { if (await check()) return; await delay(10); }
  assert.fail('Worker did not reach the expected state');
}

async function fixture(t) {
  const root = await mkdtemp(path.join(os.tmpdir(), 's8-worker-failure-'));
  const probe = net.createServer();
  await new Promise(resolve => probe.listen(0, '127.0.0.1', resolve));
  const { port } = probe.address(); await new Promise(resolve => probe.close(resolve));
  await writeFile(path.join(root, 's8-config.yml'), `telegram: {}\nworker-entries:\n  worker-1:\n    agent: pi\n    host: local\n    launch: managed\nworker-communicator:\n  bindAddress: 127.0.0.1\n  port: ${port}\n  url: http://127.0.0.1:${port}\n`);
  const communicator = await startWorkerCommunicator({ root });
  const runId = randomUUID(), directory = path.join(root, '.s8-runtime/runs', runId);
  await mkdir(directory, { recursive: true });
  const request = { root, workerId: 'worker-1', task: { uid: 'task-fixture' }, run: { runId, directory, workspace: root } };
  const assignment = { action: 'assign', runId, uid: request.task.uid, request };
  let worker, executions = 0;
  t.after(async () => { await worker?.close(); await worker?.wait(); await communicator.close(); await delay(250); await rm(root, { recursive: true, force: true }); });
  return {
    root, assignment, executions: () => executions,
    async start() {
      worker = await startDeveloperWorker(root, 'worker-1', { executeWork: async () => {
        executions++;
        await writeFile(path.join(directory, 'worker-result.json'), JSON.stringify({ status: 'completed', summary: 'fixture' }));
      } });
      await until(async () => (await getWorkerState(root, 'worker-1'))?.status === 'idle');
    },
  };
}

test('timed out assignments cannot execute when a worker connects later', async t => {
  const f = await fixture(t);
  await assert.rejects(workerRequest(f.root, 'worker-1', f.assignment, 30), /timed out/);
  await f.start();
  await delay(250);
  assert.equal(f.executions(), 0);
  assert.equal((await readWorkerMessages(f.root, 'worker-1'))[0].value.status, 'canceled');
  assert.equal((await getWorkerState(f.root, 'worker-1')).status, 'idle');
});

test('supervisor recovery withdraws an undelivered assignment before reporting failure', async t => {
  const f = await fixture(t), { runId, uid } = f.assignment;
  await enqueueWorkerMessage(f.root, 'worker-1', 'assign', f.assignment);
  const locks = path.join(f.root, '.s8-runtime/development-locks');
  await mkdir(locks, { recursive: true });
  await writeFile(path.join(locks, `${uid}.json`), JSON.stringify({ runId, workerId: 'worker-1', supervisorPid: 2147483647 }));
  let reports = 0;
  const client = {
    getWorkflow: async () => ({ uid, state: 'doing', workflow: { revision: 3, run: { id: runId } } }),
    workflow: async (_uid, operation) => { reports++; assert.equal(operation.report.status, 'failed'); return { state: 'blocked' }; },
  };
  assert.deepEqual(await recoverDevelopmentRuns({ root: f.root, client }), [{ runId, status: 'reconciled' }]);
  await f.start();
  await delay(250);
  assert.equal(reports, 1);
  assert.equal(f.executions(), 0);
  assert.equal((await readWorkerMessages(f.root, 'worker-1'))[0].value.status, 'canceled');
});

for (const lostResponse of [false, true]) {
  test(`admission retries exactly once when the busy ${lostResponse ? 'response' : 'request'} is lost`, async t => {
    const f = await fixture(t), fetcher = globalThis.fetch;
    let injected = false;
    await f.start();
    globalThis.fetch = async (url, options) => {
      if (!injected && String(url).endsWith('/state') && JSON.parse(options?.body ?? '{}').state?.status === 'busy') {
        injected = true;
        if (lostResponse) await fetcher(url, options);
        throw new TypeError('fixture connection lost');
      }
      return fetcher(url, options);
    };
    try {
      assert.equal((await workerRequest(f.root, 'worker-1', f.assignment)).accepted, true);
      await until(async () => (await getWorkerState(f.root, 'worker-1')).status === 'reported');
      assert.equal(f.executions(), 1);
      assert.equal(injected, true);
    } finally { globalThis.fetch = fetcher; }
  });
}

test('withdrawal wins against an in-flight execution permission request', async t => {
  const f = await fixture(t), fetcher = globalThis.fetch;
  let resume, intercepted = false;
  await f.start();
  globalThis.fetch = async (url, options) => {
    if (!intercepted && String(url).endsWith('/state') && JSON.parse(options?.body ?? '{}').state?.status === 'busy') {
      intercepted = true;
      await new Promise(resolve => { resume = resolve; });
    }
    return fetcher(url, options);
  };
  try {
    const pending = workerRequest(f.root, 'worker-1', f.assignment, 1000);
    await assert.rejects(pending, /timed out/);
    assert.equal(intercepted, true);
    resume();
    await until(async () => (await getWorkerState(f.root, 'worker-1')).status === 'idle');
    await delay(250);
    assert.equal(f.executions(), 0);
  } finally { resume?.(); globalThis.fetch = fetcher; }
});
