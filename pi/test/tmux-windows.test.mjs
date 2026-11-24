import test from 'node:test';
import assert from 'node:assert/strict';
import { stopWindow } from '../lib/runtime/tmux-windows.mjs';

test('stopWindow stops a raw-mode pane by signaling its process group', async () => {
  const signals = [];
  let dead = '0';
  const run = async args => {
    if (args[0] === 'list-windows') return { stdout: `@1\tpi\t/root\t${dead}` };
    if (args[0] === 'display-message') return { stdout: '33509' };
    return { stdout: '' };
  };
  const kill = (pid, signal) => { signals.push([pid, signal]); dead = '1'; };

  await stopWindow(run, '/root', 's8-general', 'pi', { timeoutMs: 1000, kill });

  assert.deepEqual(signals, [[-33509, 'SIGTERM']]);
});

test('stopWindow keeps Ctrl-C when the window stops on its own', async () => {
  const signals = [];
  let dead = '0';
  const run = async args => {
    if (args[0] === 'send-keys') { dead = '1'; return { stdout: '' }; }
    if (args[0] === 'list-windows') return { stdout: `@1\tpi\t/root\t${dead}` };
    return { stdout: '' };
  };

  await stopWindow(run, '/root', 's8-general', 'pi', { timeoutMs: 1000, kill: (...args) => signals.push(args) });

  assert.deepEqual(signals, []);
});