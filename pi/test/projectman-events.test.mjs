import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, writeFile, appendFile, rm, symlink, link } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { readEventPage } from '../lib/projectman/events.mjs';

async function fixture(t, text) {
  const root = await mkdtemp(path.join(os.tmpdir(), 's8-events-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const file = path.join(root, 'events.jsonl'); await writeFile(file, text);
  return { root, file };
}

test('event byte cursors and legacy line offsets return the same complete UTF-8 records', async t => {
  const rows = Array.from({ length: 65 }, (_, i) => ({ i, text: '한글🙂' }));
  const { file } = await fixture(t, rows.map(row => JSON.stringify(row) + '\n').join(''));
  const first = await readEventPage(file);
  assert.deepEqual(first.events, rows.slice(0, 30)); assert.equal(first.nextOffset, 30);
  const second = await readEventPage(file, { cursor: first.nextCursor });
  assert.deepEqual(second.events, rows.slice(30, 60));
  assert.deepEqual((await readEventPage(file, { offset: 30 })).events, second.events);
  const last = await readEventPage(file, { cursor: second.nextCursor });
  assert.deepEqual(last.events, rows.slice(60)); assert.equal(last.nextCursor, null);
});

test('a trailing incomplete event is not parsed or skipped and becomes readable after append', async t => {
  const { file } = await fixture(t, '{"i":1}\n{"text":"한');
  const first = await readEventPage(file);
  assert.deepEqual(first.events, [{ i: 1 }]); assert.equal(first.nextCursor, Buffer.byteLength('{"i":1}\n'));
  assert.deepEqual((await readEventPage(file, { cursor: first.nextCursor })).events, []);
  await appendFile(file, '글"}\n');
  const next = await readEventPage(file, { cursor: first.nextCursor });
  assert.deepEqual(next.events, [{ text: '한글' }]); assert.equal(next.nextCursor, null);
});

test('running logs can be followed from an empty file or a clean end of file', async t => {
  const { file } = await fixture(t, '');
  const empty = await readEventPage(file, { follow: true });
  assert.deepEqual(empty, { events: [], nextOffset: 0, nextCursor: 0 });
  await appendFile(file, '{"i":1}\n');
  const first = await readEventPage(file, { cursor: empty.nextCursor, follow: true });
  assert.deepEqual(first.events, [{ i: 1 }]); assert.ok(first.nextCursor > 0);
  const complete = await readEventPage(file, { cursor: first.nextCursor });
  assert.equal(complete.nextCursor, null);
});

test('files above 10MB remain pageable without reading the entire file for cursor pages', async t => {
  const row = JSON.stringify({ text: '가'.repeat(100) }) + '\n';
  const { file } = await fixture(t, row.repeat(40000));
  assert.ok(Buffer.byteLength(row) * 40000 > 10000000);
  const first = await readEventPage(file, { cursor: 0 });
  assert.equal(first.events.length, 30); assert.equal(first.nextCursor, Buffer.byteLength(row) * 30);
  assert.equal((await readEventPage(file, { cursor: Buffer.byteLength(row) * 39990 })).events.length, 10);
});

test('pages also have a byte budget; one oversized event has an explicit error', async t => {
  const row = JSON.stringify({ text: 'x'.repeat(400000) }) + '\n';
  const { file } = await fixture(t, row.repeat(5));
  const first = await readEventPage(file); assert.equal(first.events.length, 2);
  assert.equal((await readEventPage(file, { cursor: first.nextCursor })).events.length, 2);
  await writeFile(file, JSON.stringify({ text: 'x'.repeat(2000001) }) + '\n');
  await assert.rejects(readEventPage(file), error => error.status === 413 && error.code === 'LOG_LINE_TOO_LARGE');
});

test('invalid cursors, truncated logs, and corrupt completed records fail explicitly', async t => {
  const { file } = await fixture(t, '{"i":1}\n');
  for (const cursor of [-1, 0.5, 2]) await assert.rejects(readEventPage(file, { cursor }), error => error.status === 400);
  await assert.rejects(readEventPage(file, { cursor: 100 }), error => error.code === 'LOG_CHANGED');
  await writeFile(file, 'not-json\n');
  await assert.rejects(readEventPage(file), error => error.code === 'LOG_CORRUPT');
  await writeFile(file, Buffer.from([0xff, 10]));
  await assert.rejects(readEventPage(file), error => error.code === 'LOG_CORRUPT');
});

test('artifact readers refuse symlinks and multiply-linked files', async t => {
  const { root, file } = await fixture(t, '{"i":1}\n');
  const alias = path.join(root, 'alias'); await symlink(file, alias);
  await assert.rejects(readEventPage(alias));
  await link(file, path.join(root, 'hardlink'));
  await assert.rejects(readEventPage(file), error => error.status === 400);
});
