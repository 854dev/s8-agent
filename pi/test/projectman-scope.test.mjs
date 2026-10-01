import assert from 'node:assert/strict';
import { test } from 'node:test';
import scoped from '../extensions/projectman-read-scope.ts';
import guard from '../extensions/s8-guard.ts';

test('scopes read tools and blocks credentials', async () => {
  const cwd = process.cwd();
  const original = process.env.S8_AUTOPILOT_SCOPE;
  process.env.S8_AUTOPILOT_SCOPE = cwd;
  try {
    let scopeCheck;
    scoped({ on(_name, handler) { scopeCheck = handler; } });
    assert.equal(await scopeCheck({ toolName: 'read', input: { path: 'README.md' } }, { cwd }), undefined);
    assert.equal((await scopeCheck({ toolName: 'read', input: { path: '../854_md/README.md' } }, { cwd })).block, true);
    assert.equal((await scopeCheck({ toolName: 'grep', input: {} }, { cwd })).block, true);
    let guardCheck;
    guard({ on(_name, handler) { guardCheck = handler; } });
    assert.equal((await guardCheck({ toolName: 'read', input: { path: '.env' } }, { cwd, hasUI: false })).block, true);
  } finally {
    if (original === undefined) delete process.env.S8_AUTOPILOT_SCOPE;
    else process.env.S8_AUTOPILOT_SCOPE = original;
  }
});
