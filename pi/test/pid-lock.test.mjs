import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, writeFile, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { acquirePidLock, waitUntil } from '../lib/runtime/process.mjs';

test('PID lock rejects live or unreadable owners, replaces dead owners and releases', async t => {
  const root = await mkdtemp(path.join(os.tmpdir(), 's8-pid-lock-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const file = path.join(root, 'owner.lock');
  const release = await acquirePidLock(file, { extra: 'note\n' });
  assert.equal(await readFile(file, 'utf8'), `${process.pid}\nnote\n`);
  await assert.rejects(acquirePidLock(file), { code: 'ELOCKED', pid: process.pid });
  await release();
  await assert.rejects(readFile(file), { code: 'ENOENT' });
  await writeFile(file, '2147483647\n');
  await (await acquirePidLock(file))();
  await writeFile(file, '');
  await assert.rejects(acquirePidLock(file, { waitMs: 150 }), { code: 'ELOCKED' });
});

test('waitUntil returns the first truthy value or the last value after the timeout', async () => {
  let calls = 0;
  assert.equal(await waitUntil(() => ++calls === 3 && 'done', { timeoutMs: 1000, intervalMs: 1 }), 'done');
  assert.equal(await waitUntil(() => false, { timeoutMs: 20, intervalMs: 5 }), false);
});
