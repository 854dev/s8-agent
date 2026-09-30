import assert from 'node:assert/strict';
import { mkdtemp, mkdir, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { createLibrary } from '../src/library.js';

test('lists markdown files and skips blocked directories', async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'kb-browser-'));
  await mkdir(path.join(root, 'notes'));
  await mkdir(path.join(root, 'SECRET'));
  await mkdir(path.join(root, 'docs', 'guides'), { recursive: true });
  await mkdir(path.join(root, 'docs', 'notes'), { recursive: true });
  await writeFile(path.join(root, 'notes', 'hello.md'), '# Hello');
  await writeFile(path.join(root, 'SECRET', 'hidden.md'), 'secret');
  await writeFile(path.join(root, 'docs', 'guides', 'guide.md'), '# Guide');
  await writeFile(path.join(root, 'docs', 'notes', 'note.md'), '# Note');
  const library = createLibrary(root);
  const entries = await library.entries('', 5);
  const paths = entries.map((entry) => entry.path);
  assert.ok(paths.includes('notes/hello.md'));
  assert.ok(paths.includes('docs/guides/guide.md'));
  assert.ok(paths.includes('docs/notes/note.md'));
  assert.ok(!paths.includes('SECRET/hidden.md'));
});

test('rejects traversal and blocked files', async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'kb-browser-'));
  await mkdir(path.join(root, '.pi'), { recursive: true });
  await mkdir(path.join(root, '.s8-runtime'), { recursive: true });
  await mkdir(path.join(root, 's8', '.pi-runtime'), { recursive: true });
  await writeFile(path.join(root, 'visible.md'), 'visible');
  await writeFile(path.join(root, '.pi', 'hidden.md'), 'hidden');
  await writeFile(path.join(root, '.s8-runtime', 'secret.md'), 'secret');
  await writeFile(path.join(root, 's8', '.pi-runtime', 'secret.md'), 'secret');
  const library = createLibrary(root);
  await assert.rejects(() => library.readFile('../visible.md'));
  await assert.rejects(() => library.readFile('SECRET/hidden.md'));
  await assert.rejects(() => library.readFile('.s8-runtime/secret.md'));
  await assert.rejects(() => library.readFile('s8/.pi-runtime/secret.md'));
  await assert.rejects(() => library.readFile('.pi/hidden.md'));
  const visible = await library.readFile('visible.md');
  assert.equal(visible.content, 'visible');
});

test('searches content and returns an excerpt', async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'kb-browser-'));
  await writeFile(path.join(root, 'pi.md'), 'Pi is the s8 agent.');
  const library = createLibrary(root);
  const results = await library.search('s8');
  assert.equal(results[0]?.path, 'pi.md');
  assert.match(results[0]?.excerpt ?? '', /s8/);
});
