import { test } from 'node:test';
import assert from 'node:assert/strict';
import net from 'node:net';
import { ownership } from '../extensions/telegram.mjs';

const waitFor = async predicate => {
  for (let i = 0; i < 100; i++) {
    if (predicate()) return;
    await new Promise(resolve => setTimeout(resolve, 20));
  }
  assert.fail('Telegram owner did not change');
};

test('last Pi process owns polling and prior one resumes when it exits', async t => {
  const socket = net.createServer();
  await new Promise(resolve => socket.listen(0, '127.0.0.1', resolve));
  const { port } = socket.address();
  await new Promise(resolve => socket.close(resolve));
  let first = false, second = false;
  const stopFirst = ownership({ port, key: 'test-token', interval: 20, onAcquire: () => { first = true; }, onRelease: () => { first = false; } });
  t.after(stopFirst);
  await waitFor(() => first);
  await new Promise(resolve => {
    const attacker = net.connect(port, '127.0.0.1');
    attacker.on('connect', () => attacker.write('999999999999999999:invalid'));
    attacker.on('data', () => { attacker.destroy(); resolve(); });
    attacker.setTimeout(1000, () => { attacker.destroy(); resolve(); });
  });
  assert.equal(first, true);
  // hrtime distinguishes processes even when both start during the same millisecond.
  const stopSecond = ownership({ port, key: 'test-token', interval: 20, onAcquire: () => { second = true; }, onRelease: () => { second = false; } });
  t.after(stopSecond);
  await waitFor(() => second && !first);
  stopSecond();
  await waitFor(() => first && !second);
});
