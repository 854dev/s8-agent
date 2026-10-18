import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { runProjectmanTurn } from '../lib/projectman-dispatch.ts';

test('scheduled Projectman polls use confirmed workflows and never legacy transitions', async t => {
  const root = await mkdtemp(path.join(os.tmpdir(), 's8-plan-schedule-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  let transitions = 0;
  const result = await runProjectmanTurn({ projectUid: 'project', paths: { systemPrompt: path.join(root, 'agents/developer/SYSTEM.md') }, policy: { maxConcurrency: 1 }, client: { list: async () => [], transition: () => { transitions++; } } });
  assert.equal(result.status, 'idle');
  assert.equal(transitions, 0);
});
