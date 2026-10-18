import test from 'node:test';
import assert from 'node:assert/strict';
import { runProjectmanResearch } from '../lib/projectman-run.ts';

test('legacy read-only runner cannot bypass the human-confirmed development workflow', async () => {
  let touched = false;
  const options = { client: { transition: () => { touched = true; throw new Error('Must not transition'); } }, run: () => { touched = true; throw new Error('Must not run'); } };
  const result = await runProjectmanResearch('project', 1, new AbortController().signal, options);
  assert.equal(result.status, 'retired');
  assert.match(result.message, /supervisor/);
  assert.equal(touched, false);
});
