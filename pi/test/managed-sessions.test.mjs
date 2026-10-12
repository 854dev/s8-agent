import { test } from 'node:test';
import assert from 'node:assert/strict';
import net from 'node:net';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { moveTelegram, validSession } from '../lib/managed-sessions.mjs';

test('managed session identifiers cannot inject commands or select arbitrary tmux targets', () => {
  assert.equal(validSession('s8-main'), true);
  for (const name of ['main', 's8-main:0', 's8-../foo', 's8-a;sh', 's8-']) assert.equal(validSession(name), false);
});
test('Telegram handoff goes through local session control, not terminal keystrokes', async t => {
  const dir = await mkdtemp(path.join(tmpdir(), 's8-control-'));
  const socket = path.join(dir, 'session.sock');
  const messages = [];
  const server = net.createServer(client => client.once('data', data => { messages.push(data.toString()); client.end('ok'); }));
  await new Promise(resolve => server.listen(socket, resolve));
  t.after(async () => { await new Promise(resolve => server.close(resolve)); await rm(dir, { recursive: true, force: true }); });
  await moveTelegram(socket);
  assert.deepEqual(messages, ['telegram']);
});
