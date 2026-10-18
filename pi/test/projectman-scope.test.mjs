import assert from 'node:assert/strict';
import { test } from 'node:test';
import guard from '../extensions/s8-guard.ts';

test('blocks protected credential paths', async () => {
  const cwd = process.cwd();
  let guardCheck;
  guard({ on(_name, handler) { guardCheck = handler; } });
  assert.equal((await guardCheck({ toolName: 'read', input: { path: '.env' } }, { cwd, hasUI: false })).block, true);
});
