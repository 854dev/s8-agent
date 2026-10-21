import test from 'node:test';
import assert from 'node:assert/strict';
import { message, validateMessage, requestLedger } from '../lib/communication/protocol.mjs';

const assignment = () => message('task.run', 'manager', 'a', { uid: 'TASK-1' }, { taskUid: 'TASK-1' });

test('authenticated Manager delegates a UID; Worker requests help only through Manager', () => {
  assert.equal(validateMessage(assignment(), 'manager').to, 'a');
  const request = message('agent.request', 'a', 'manager', { text: 'Please arrange a review.' }, { taskUid: 'TASK-1', runId: 'run-1', sessionId: 'session-1' });
  assert.equal(validateMessage(request, 'a').payload.text, 'Please arrange a review.');
  const reply = message('agent.reply', 'manager', 'a', { text: 'What evidence should the reviewer check?' }, { replyTo: request.id, requestId: request.requestId });
  assert.equal(reply.requestId, request.requestId);
});

test('peer routing, sender spoofing and Worker control messages are rejected', () => {
  const valid = assignment();
  assert.throws(() => validateMessage(valid, 'a'), /identity mismatch/);
  assert.throws(() => validateMessage({ ...valid, from: 'a', to: 'b' }, 'a'), /peer routing/);
  assert.throws(() => validateMessage({ ...valid, from: 'a', to: 'manager' }, 'a'), /not permitted/);
  assert.throws(() => message('worker.mode.set', 'a', 'manager', { mode: 'active' }), /not permitted/);
});

test('invalid, stale, oversized and uncorrelated messages fail without echoing contents', () => {
  const valid = assignment();
  for (const change of [
    { version: 2 }, { expiresAt: 'yesterday' }, { expiresAt: '2000-01-01' },
    { id: '../secret' }, { runId: 42 }, { payload: [] }, { command: 'fixture-secret' },
    { payload: { uid: 'different' } }, { payload: { uid: 'x'.repeat(70_000) } },
  ]) assert.throws(() => validateMessage({ ...valid, ...change }, 'manager'), error => !error.message.includes('fixture-secret'));
  assert.throws(() => message('agent.reply', 'a', 'manager', { text: 'Answer' }), /correlation/);
  assert.throws(() => message('agent.notice', 'a', 'manager', { text: '' }), /text required/);
  assert.throws(() => message('request.accepted', 'a', 'manager', { state: 'read' }), /receipt state/);
});

test('request memory is bounded, expires, and marks unconfirmed delivery unknown on disconnect', () => {
  let time = 100;
  const ledger = requestLedger({ limit: 2, now: () => time });
  ledger.set('one', { state: 'pending' }, 200);
  ledger.set('two', { state: 'finished' }, 300);
  assert.throws(() => ledger.set('three', { state: 'accepted' }, 400), /limit/);
  ledger.disconnect();
  assert.equal(ledger.get('one').state, 'unknown');
  assert.equal(ledger.get('two').state, 'finished');
  time = 201;
  assert.equal(ledger.get('one'), undefined);
  ledger.set('three', { state: 'accepted' }, 400);
  assert.equal(ledger.get('three').state, 'accepted');
  assert.throws(() => ledger.set('expired', {}, 200), /expired/);
  assert.equal(requestLedger().get('three'), undefined); // No restart replay.
});
