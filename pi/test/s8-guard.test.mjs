import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, symlinkSync, linkSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import guard from '../extensions/s8-guard.ts';

test('only a regular .env.example is accessible through path tools', async () => {
  const base = mkdtempSync(path.join(tmpdir(), 's8-guard-'));
  const cwd = path.join(base, 'project');
  mkdirSync(cwd);
  let handler;
  guard({ on(_event, fn) { handler = fn; } });
  const blocked = async (toolName, file) => Boolean(await handler({ toolName, input: { path: file } }, { cwd, hasUI: false }));
  try {
    writeFileSync(path.join(cwd, '.env.example'), 'PLACEHOLDER=example');
    assert.equal(await blocked('read', '.env.example'), false);
    assert.equal(await blocked('edit', '.env.example'), false);
    assert.equal(await blocked('write', '.env.example'), false);
    assert.equal(await blocked('read', '.env'), true);
    assert.equal(await blocked('write', '.env.local'), true);
    assert.equal(await blocked('edit', '.env.production'), true);
    assert.equal(await blocked('read', '.env.example/anything'), true);
    assert.equal(await blocked('write', '.pi/.env.example'), true);
    const linked = path.join(cwd, 'linked');
    mkdirSync(linked);
    symlinkSync(path.join(cwd, '.env'), path.join(linked, '.env.example'));
    assert.equal(await blocked('write', 'linked/.env.example'), true); // dangling secret link
    writeFileSync(path.join(linked, 'ordinary'), 'example');
    rmSync(path.join(linked, '.env.example'));
    linkSync(path.join(linked, 'ordinary'), path.join(linked, '.env.example'));
    assert.equal(await blocked('edit', 'linked/.env.example'), true); // hardlink
    symlinkSync(path.join(base, '.pi'), path.join(cwd, 'alias'));
    assert.equal(await blocked('write', 'alias/.env.example'), true); // protected parent
  } finally { rmSync(base, { recursive: true, force: true }); }
});
