import test from 'node:test';
import assert from 'node:assert/strict';
import os from 'node:os';
import path from 'node:path';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { ensureWorkerPool } from '../lib/development/worker-pool.mjs';

test('pool starts configured managed SSH workers but leaves external workers alone', async t => {
  const root = await mkdtemp(path.join(os.tmpdir(), 's8-remote-pool-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  await writeFile(path.join(root, 's8-config.yml'), `telegram: {}\nworker-entries:\n  remote-claude-1:\n    agent: claude-code\n    host: ssh://dev@devbox\n    launch: managed\n    root: /opt/s8-agent\n  external-claude:\n    agent: claude-code\n    launch: external\n`);
  const sshCalls = [];
  const ssh = async (binary, args) => { sshCalls.push([binary, args]); return { stdout: 'started', stderr: '' }; };
  const run = async args => {
    if (args[0] === 'wait-for') return { stdout: '' };
    if (args[0] === 'has-session') throw new Error('no local worker session');
    assert.fail(`unexpected tmux command: ${args.join(' ')}`);
  };
  const result = await ensureWorkerPool(root, { run, ssh });
  assert.equal(result.session, null);
  assert.equal(result.count, 2);
  assert.deepEqual(result.remoteWorkers.map(worker => worker.workerId), ['remote-claude-1']);
  assert.equal(result.remoteWorkers[0].status, 'starting');
  assert.equal(sshCalls.length, 1);
});
