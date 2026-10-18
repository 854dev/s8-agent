import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { runProjectmanTurn } from '../lib/projectman/dispatch.ts';

test('scheduled Projectman polls use confirmed workflows', async t => {
  const root = await mkdtemp(path.join(os.tmpdir(), 's8-plan-schedule-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const result = await runProjectmanTurn({ root, projectUid: 'project', policy: { maxConcurrency: 1 }, client: { list: async () => [] } });
  assert.equal(result.status, 'idle');
});
