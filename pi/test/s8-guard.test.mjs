import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, symlinkSync, linkSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import guard from '../extensions/s8-guard.ts';

test('only env and secret paths are blocked; new directories and .env.example remain accessible', async () => {
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
    assert.equal(await blocked('write', '.pi/.env.example'), false);
    assert.equal(await blocked('write', 'new/nested/file.txt'), false);
    assert.equal(await blocked('read', '.git/config'), false);
    assert.equal(await blocked('write', 'new/nested/secret-notes.txt'), true);
    assert.equal(await blocked('read', 'SECRET/note.txt'), true);
    assert.equal(await blocked('write', 'new/.env.example/file.txt'), true);
    const linked = path.join(cwd, 'linked');
    mkdirSync(linked);
    symlinkSync(path.join(cwd, '.env'), path.join(linked, '.env.example'));
    assert.equal(await blocked('write', 'linked/.env.example'), true); // dangling secret link
    writeFileSync(path.join(linked, 'ordinary'), 'example');
    rmSync(path.join(linked, '.env.example'));
    linkSync(path.join(linked, 'ordinary'), path.join(linked, '.env.example'));
    assert.equal(await blocked('edit', 'linked/.env.example'), true); // hardlink
    mkdirSync(path.join(base, 'secret-files'));
    symlinkSync(path.join(base, 'secret-files'), path.join(cwd, 'alias'));
    assert.equal(await blocked('write', 'alias/new/nested/file.txt'), true); // resolved protected parent
    symlinkSync(path.join(base, 'secret-files', 'missing'), path.join(cwd, 'dangling'));
    assert.equal(await blocked('write', 'dangling'), true);
    assert.equal(await blocked('write', 'alias/.env.example'), true);
    assert.equal(await blocked('write', path.join(base, 'ordinary', 'file.txt')), false);
    const shell = async command => Boolean(await handler({ toolName: 'bash', input: { command } }, { cwd, hasUI: false }));
    assert.equal(await shell('ls .pi'), false);
    assert.equal(await shell('printf .env.example'), false);
    assert.equal(await shell('ls .env.local'), true);
    assert.equal(await shell('ls secret-files'), true);
  } finally { rmSync(base, { recursive: true, force: true }); }
});
