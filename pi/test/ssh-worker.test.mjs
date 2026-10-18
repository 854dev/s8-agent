import test from 'node:test';
import assert from 'node:assert/strict';
import { ensureRemoteWorker, remoteWorkerSession, sshCommand, stopRemoteWorkerIfExited } from '../lib/development/ssh-worker.mjs';

test('managed SSH worker starts in a stable per-ID tmux session using an argument-safe remote script', async () => {
  let invocation;
  const exec = async (...args) => { invocation = args; return { stdout: 'started', stderr: '' }; };
  const result = await ensureRemoteWorker('remote-claude-1', { agent: 'claude-code', host: 'ssh://dev@devbox', root: "/opt/s8 agent's", launch: 'managed' }, { exec });
  assert.equal(result.status, 'starting');
  assert.equal(result.session, remoteWorkerSession('remote-claude-1'));
  assert.deepEqual(invocation[0], 'ssh');
  assert.equal(invocation[1].includes('dev@devbox'), true);
  const remoteCommand = invocation[1].at(-1);
  assert.match(remoteCommand, /command -v claude/);
  assert.match(remoteCommand, /tmux new-session/);
  assert.match(remoteCommand, /worker_command=/);
  assert.match(remoteCommand, /s8 agent/);
  assert.equal(remoteCommand.includes('fixture-secret'), false);
});

test('removed managed remote workers are only cleaned up after their tmux pane has exited', async () => {
  const scripts = [];
  const exec = async (_binary, args) => { scripts.push(args.at(-1)); return { stdout: 'active', stderr: '' }; };
  const result = await stopRemoteWorkerIfExited('remote-pi-1', { host: 'ssh://dev@devbox', root: '/opt/s8' }, { exec });
  assert.equal(result.status, 'active');
  assert.match(scripts[0], /pane_dead/);
  assert.match(scripts[0], /tmux kill-session/);
});

test('SSH lifecycle rejects malformed targets and masks process errors', async () => {
  await assert.rejects(sshCommand('ssh://dev:password@devbox', 'true', { exec: async () => ({ stdout: '' }) }), /Invalid SSH worker address/);
  await assert.rejects(sshCommand('ssh://dev@devbox', 'true', { exec: async () => { throw new Error('password=do-not-show'); } }), /unreachable or rejected/);
});
