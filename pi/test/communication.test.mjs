import test from 'node:test';
import assert from 'node:assert/strict';
import { message, validateMessage } from '../lib/communication/protocol.mjs';

const assignment = () => message('agent.request', 'manager', 'a', { text: 'Please check the evidence.' });

test('authenticated Manager sends text; Worker requests help only through Manager', () => {
  assert.equal(validateMessage(assignment(), 'manager').to, 'a');
  const request = message('agent.request', 'a', 'manager', { text: 'Please arrange a review.' }, { taskUid: 'TASK-1', sessionId: 'session-1' });
  assert.equal(validateMessage(request, 'a').payload.text, 'Please arrange a review.');
  const reply = message('agent.reply', 'manager', 'a', { text: 'What evidence should the reviewer check?' }, { replyTo: request.id, requestId: request.requestId });
  assert.equal(reply.requestId, request.requestId);
});

test('peer routing, sender spoofing and Worker control messages are rejected', () => {
  const valid = assignment();
  assert.throws(() => validateMessage(valid, 'a'), /identity mismatch/);
  assert.throws(() => validateMessage({ ...valid, from: 'a', to: 'b' }, 'a'), /peer routing/);
  for (const type of ['task.run', 'worker.mode.set', 'worker.status', 'task.completed']) {
    assert.throws(() => message(type, 'manager', 'a', { text: 'forbidden' }), /not permitted/);
    assert.throws(() => message(type, 'a', 'manager', { text: 'forbidden' }), /not permitted/);
  }
  assert.throws(() => message('worker.mode.set', 'a', 'manager', { mode: 'active' }), /not permitted/);
});

test('invalid, stale, oversized and uncorrelated messages fail without echoing contents', () => {
  const valid = assignment();
  for (const change of [
    { version: 1 }, { expiresAt: 'yesterday' }, { expiresAt: '2000-01-01' },
    { id: '../secret' }, { sessionId: 42 }, { payload: [] }, { command: 'fixture-secret' },
    { payload: { uid: 'different' } }, { payload: { uid: 'x'.repeat(70_000) } },
  ]) assert.throws(() => validateMessage({ ...valid, ...change }, 'manager'), error => !error.message.includes('fixture-secret'));
  assert.throws(() => message('agent.reply', 'a', 'manager', { text: 'Answer' }), /correlation/);
  assert.throws(() => message('agent.notice', 'a', 'manager', { text: '' }), /text required/);
  assert.throws(() => message('request.result', 'a', 'manager', { state: 'read' }), /receipt state/);
});
