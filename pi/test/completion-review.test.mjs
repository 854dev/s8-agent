import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm, mkdir, writeFile, readFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { randomUUID, createHash } from 'node:crypto';
import { submitCompletionReview, recoverCompletionReviews } from '../lib/projectman/completion-review.mjs';
import { drainManagerInbox, managerInboxMessage } from '../lib/manager/inbox.mjs';

async function fixture(t) {
  const root = await mkdtemp(path.join(os.tmpdir(), 's8-completion-review-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const logs = [], operations = [];
  let loseResponse = false;
  const client = {
    getWorkflow: async () => ({ state: 'review', workflow: { run: { id: randomUUID() }, result: { summary: 'Implementation verified' } } }),
    workflow: async (uid, operation) => {
      operations.push(operation);
      if (!logs.length) logs.push({ detail: { attributes: { event: 'complete', requestId: operation.requestId, fingerprint: createHash('sha256').update(JSON.stringify(Object.fromEntries(Object.keys(operation).sort().map(key => [key, operation[key]])))).digest('hex'), result: { state: 'done' } } } });
      if (loseResponse) { loseResponse = false; throw new Error('Response lost after commit'); }
      return { uid, state: 'done' };
    },
    list: async (type, uid) => { assert.equal(type, 'work_log'); assert.equal(uid, 'task-1'); return logs; },
  };
  const input = { action: 'complete', requestId: randomUUID(), expectedRevision: 4, reviewComment: '모바일 간격을 보완해주세요.' };
  return { root, client, logs, operations, input, loseResponse() { loseResponse = true; } };
}

test('human completion records comments in the existing API and queues one manager review across replay', async t => {
  const f = await fixture(t);
  assert.equal((await submitCompletionReview({ ...f, uid: 'task-1' })).state, 'done');
  assert.deepEqual(f.operations[0], { action: 'complete', requestId: f.input.requestId, expectedRevision: 4, message: '사용자 검토의견:\n모바일 간격을 보완해주세요.' });
  const messages = [];
  await drainManagerInbox(f.root, event => messages.push(event));
  await submitCompletionReview({ ...f, uid: 'task-1' });
  await recoverCompletionReviews(f.root, f.client);
  await drainManagerInbox(f.root, event => messages.push(event));
  assert.equal(messages.length, 1);
  assert.equal(messages[0].type, 'completion_review'); assert.equal(messages[0].reviewComment, f.input.reviewComment);
  const prompt = managerInboxMessage(messages[0]);
  assert.match(prompt.content, /추가 조치가 없으면/); assert.match(prompt.content, /불명확하면 사용자에게 질문/);
  assert.match(prompt.content, /spec.dependsOn/); assert.match(prompt.content, /별도의 사용자 계획 승인/);
  assert.ok(prompt.content.includes(messages[0].sourceRef));
  await assert.rejects(submitCompletionReview({ ...f, uid: 'task-1', input: { ...f.input, reviewComment: '다른 의견' } }), error => error.status === 409);
});

test('a lost completion response is recovered from its exact immutable work log without a human write', async t => {
  const f = await fixture(t); f.loseResponse();
  await assert.rejects(submitCompletionReview({ ...f, uid: 'task-1' }), /Response lost/);
  const events = [];
  await drainManagerInbox(f.root, event => events.push(event)); assert.equal(events.length, 0);
  const manager = { list: f.client.list, workflow: () => assert.fail('Manager must never replay human completion') };
  await recoverCompletionReviews(f.root, manager);
  await drainManagerInbox(f.root, event => events.push(event));
  assert.equal(events.length, 1); assert.equal(events[0].requestId, f.input.requestId);
  assert.equal(f.operations.length, 1);
});

test('completion survives an inbox storage failure and can be delivered after restart', async t => {
  const f = await fixture(t);
  await mkdir(path.join(f.root, '.s8-runtime'), { recursive: true });
  const blocker = path.join(f.root, '.s8-runtime/manager-inbox'); await writeFile(blocker, 'storage unavailable');
  await assert.rejects(submitCompletionReview({ ...f, uid: 'task-1' }));
  assert.equal(f.logs.length, 1);
  await rm(blocker);
  await recoverCompletionReviews(f.root, f.client);
  const events = []; await drainManagerInbox(f.root, event => events.push(event));
  assert.equal(events.length, 1);
  const intent = JSON.parse(await readFile(path.join(f.root, '.s8-runtime/completion-reviews', `${f.input.requestId}.json`), 'utf8'));
  assert.equal(intent.delivered, true);
});

test('unconfirmed requests and completions by a different request ID never trigger follow-up processing', async t => {
  const f = await fixture(t);
  f.client.workflow = async () => { throw Object.assign(new Error('Forbidden completion'), { status: 403 }); };
  await assert.rejects(submitCompletionReview({ ...f, uid: 'task-1' }), /Forbidden/);
  f.logs.push({ detail: { attributes: { event: 'complete', requestId: randomUUID(), result: { state: 'done' } } } });
  f.logs.push({ detail: { attributes: { event: 'complete', requestId: f.input.requestId, fingerprint: 'different-operation', result: { state: 'done' } } } });
  await recoverCompletionReviews(f.root, f.client);
  const events = []; await drainManagerInbox(f.root, event => events.push(event)); assert.equal(events.length, 0);
});

test('comments are optional and invalid payloads cannot reach the completion API', async t => {
  const f = await fixture(t);
  for (const patch of [{ reviewComment: 7 }, { reviewComment: 'x'.repeat(6001) }, { requestId: '../escape' }, { expectedRevision: -1 }, { grant: true }]) {
    await assert.rejects(submitCompletionReview({ ...f, uid: 'task-1', input: { ...f.input, ...patch } }), error => error.status === 400);
  }
  assert.equal(f.operations.length, 0);
  await submitCompletionReview({ ...f, uid: 'task-1', input: { ...f.input, reviewComment: '  ' } });
  assert.match(f.operations[0].message, /검토의견 없음/);
  const events = []; await drainManagerInbox(f.root, event => events.push(event)); assert.equal(events[0].reviewComment, '');
});


test('failure to persist review intent prevents completion from being sent', async t => {
  const f = await fixture(t);
  await mkdir(path.join(f.root, '.s8-runtime'), { recursive: true });
  await writeFile(path.join(f.root, '.s8-runtime/completion-reviews'), 'storage unavailable');
  await assert.rejects(submitCompletionReview({ ...f, uid: 'task-1' }));
  assert.equal(f.operations.length, 0);
});
