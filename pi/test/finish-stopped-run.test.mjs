import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { finishStoppedRun, finishStoppedRunCommand } from '../lib/development/finish-stopped-run.mjs';

async function fixture(t) {
  const root = await mkdtemp(path.join(tmpdir(), 's8-stopped-run-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const uid = 'cnt_fixture', runId = '42246c5d-2e21-48d6-abe3-17db58dd0dcf';
  const current = { state: 'doing', workflow: { revision: 7, run: { id: runId, status: 'running' } } };
  const writes = [];
  const client = {
    getWorkflow: async () => structuredClone(current),
    workflow: async (id, operation) => {
      writes.push({ id, operation });
      if (operation.expectedRevision !== current.workflow.revision) throw Object.assign(new Error('HTTP 409'), { status: 409 });
      current.state = 'blocked'; current.workflow.run.status = 'finished'; current.workflow.revision++;
      return structuredClone(current);
    },
  };
  return { root, uid, runId, confirmed: true, states: async () => [], current, writes, client };
}

test('missing-lock orphan receives a failed report; repeats never overwrite the result', async t => {
  const f = await fixture(t);
  assert.equal((await finishStoppedRun(f)).status, 'finished');
  assert.equal(f.current.state, 'blocked');
  const { id, operation } = f.writes[0];
  assert.equal(id, f.uid);
  assert.equal(operation.runId, f.runId);
  assert.equal(operation.expectedRevision, 7);
  assert.equal(operation.action, 'report');
  assert.equal(operation.report.status, 'failed');
  assert.deepEqual(operation.report.verification, []);
  assert.ok(operation.report.executionErrors.length);
  assert.equal((await finishStoppedRun(f)).status, 'already-finished');
  assert.equal(f.writes.length, 1);
});

test('recovery requires explicit operator confirmation, valid IDs and exact CLI arguments', async t => {
  const f = await fixture(t);
  for (const override of [{ confirmed: false }, { uid: '../other' }, { runId: 'wrong-run' }]) {
    await assert.rejects(finishStoppedRun({ ...f, ...override }));
  }
  await assert.rejects(finishStoppedRunCommand(f.root, f.client, ['--finish-stopped-run', f.uid, '--run-id', f.runId]), /Usage/);
  assert.equal(f.writes.length, 0);
});

test('local recovery locks and active or uncertain workers prevent manual reporting', async t => {
  const f = await fixture(t);
  for (const worker of [{ alive: true, status: 'reported' }, { alive: false, status: 'busy' }, { alive: false, status: 'unknown' }, { alive: false, status: 'accepting' }]) {
    await assert.rejects(finishStoppedRun({ ...f, states: async () => [{ ...worker, runId: f.runId }] }), /worker/);
  }
  await mkdir(path.join(f.root, '.s8-runtime/development-locks'), { recursive: true });
  await writeFile(path.join(f.root, '.s8-runtime/development-locks', `${f.uid}.json`), '{}');
  await assert.rejects(finishStoppedRun(f), /local recovery lock/);
  assert.equal(f.writes.length, 0);
});

test('changed runs, changed states, permissions and revision conflicts never fall back to deletion', async t => {
  const f = await fixture(t);
  for (const current of [
    { state: 'doing', workflow: { run: { id: 'other', status: 'running' } } },
    { state: 'canceled', workflow: { run: { id: f.runId, status: 'cancel_requested' } } },
  ]) {
    await assert.rejects(finishStoppedRun({ ...f, client: { ...f.client, getWorkflow: async () => current } }));
  }
  assert.equal(f.writes.length, 0);
  for (const status of [403, 409]) {
    const error = Object.assign(new Error(`HTTP ${status}`), { status });
    await assert.rejects(finishStoppedRun({ ...f, client: { ...f.client, workflow: async () => { throw error; } } }), e => e === error);
  }
});

test('an unconfirmed server response is not reported as a successful repair', async t => {
  const f = await fixture(t);
  await assert.rejects(finishStoppedRun({ ...f, client: { ...f.client, workflow: async () => f.current } }), /did not confirm/);
});

test('retry after a lost report response observes completion without submitting again', async t => {
  const f = await fixture(t);
  const client = { ...f.client, workflow: async (...args) => {
    await f.client.workflow(...args);
    throw new TypeError('fetch failed');
  } };
  await assert.rejects(finishStoppedRun({ ...f, client }), /fetch failed/);
  assert.equal((await finishStoppedRun({ ...f, client })).status, 'already-finished');
  assert.equal(f.writes.length, 1);
});
