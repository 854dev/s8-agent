import assert from 'node:assert/strict';
import { test } from 'node:test';
import { eligibleForReadOnly, needsConfirmation, runBoundedProcess } from '../lib/projectman-autopilot.ts';

const task = {
  uid: 't', type: 'task', title: 'Read docs', status: 'published', created_at: '2026-01-01', updated_at: null,
  tags: [], detail: { text: 'Read only; cite files', attributes: {
    state: 'ready', autorun: true, autorunMode: 'safe', risk: 'low', requiresApproval: false, allowedActions: ['read'],
  } },
};

test('only explicitly safe, unapproved read tasks are eligible', () => {
  assert.equal(eligibleForReadOnly(task), true);
  assert.equal(eligibleForReadOnly({ ...task, tags: ['need:review'] }), false);
  assert.equal(needsConfirmation({ ...task, tags: ['risk:sensitive'] }), true);
  assert.equal(eligibleForReadOnly({ ...task, detail: { ...task.detail, attributes: { ...task.detail.attributes, allowedActions: ['read', 'edit'] } } }), false);
  assert.equal(eligibleForReadOnly({ ...task, detail: { ...task.detail, attributes: { ...task.detail.attributes, requiresApproval: true } } }), false);
});

test('read-only child completes or is stopped at its deadline', async () => {
  const cwd = process.cwd();
  const ok = await runBoundedProcess(process.execPath, ['-e', "console.log('done')"], cwd, 5000, new AbortController().signal, cwd);
  assert.equal(ok.status, 'completed');
  assert.match(ok.output, /done/);
  const expired = await runBoundedProcess(process.execPath, ['-e', 'setInterval(() => {}, 1000)'], cwd, 100, new AbortController().signal, cwd);
  assert.equal(expired.status, 'timeout');
  const controller = new AbortController();
  const run = runBoundedProcess(process.execPath, ['-e', 'setInterval(() => {}, 1000)'], cwd, 5000, controller.signal, cwd);
  setTimeout(() => controller.abort(), 100);
  assert.equal((await run).status, 'stopped');
});
