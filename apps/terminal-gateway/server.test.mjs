import { test } from 'node:test';
import assert from 'node:assert/strict';
import { once } from 'node:events';
import { execFileSync } from 'node:child_process';
import * as pty from 'node-pty';
import { WebSocket } from 'ws';
import { createGateway, sameOrigin, size } from './server.mjs';

const connect = async (url, origin) => {
  const ws = new WebSocket(url, { origin });
  await once(ws, 'open');
  return ws;
};
test('real PTY controls an unmarked PHCMS session and preserves it after web disconnect', async t => {
  const socketName = `s8-terminal-test-${process.pid}`;
  execFileSync('tmux', ['-L', socketName, 'new-session', '-d', '-s', 'phcms', '/bin/sh']);
  t.after(() => { try { execFileSync('tmux', ['-L', socketName, 'kill-server']); } catch {} });
  const server = createGateway({ sessions: async () => ['phcms'], spawn: (_cmd, args, options) => pty.spawn('tmux', ['-L', socketName, ...args], options) });
  server.listen(0, '127.0.0.1'); await once(server, 'listening');
  t.after(() => server.stop());
  const base = `http://127.0.0.1:${server.address().port}`;
  const url = base.replace('http:', 'ws:') + '/api/terminal/ws?session=phcms';
  const client = await connect(url, base);
  await new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error('PTY output timeout')), 3000);
    let output = '';
    client.on('message', data => { output += data.toString(); if (output.includes('S8_PTY_OK')) { clearTimeout(timer); resolve(); } });
    client.send(JSON.stringify({ type: 'input', data: "printf 'S8_PTY_%s\\n' OK\r" }));
  });
  const closed = once(client, 'close'); client.close(); await closed;
  execFileSync('tmux', ['-L', socketName, 'has-session', '-t', '=phcms']);
  const again = await connect(url, base);
  const disconnected = once(again, 'close'); again.close(); await disconnected;
});

test('origin and terminal dimensions are validated', () => {
  assert.equal(sameOrigin({ headers: { host: '100.120.50.80', origin: 'http://evil' } }, true), false);
  assert.equal(sameOrigin({ headers: { host: '100.120.50.80' } }, true), false);
  assert.equal(sameOrigin({ headers: { host: '100.120.50.80', origin: 'http://100.120.50.80' } }, true), true);
  assert.equal(sameOrigin({ headers: { host: 'evil.example', origin: 'http://evil.example' } }, true), false);
  assert.equal(size({ cols: 80, rows: 24 }), true);
  assert.equal(size({ cols: 99999, rows: 24 }), false);
});
test('web terminal attaches listed host services, rejects absent or pane targets, and detaches without stopping services', async t => {
  let onData, onExit;
  const calls = [];
  const sessions = ['s8-main', 'phcms', 's8-scheduler', 's8-development-supervisor', 's8-host-shell', '호스트 셸'];
  const server = createGateway({ sessions: async () => sessions, shell: async () => 's8-host-shell', spawn: (command, args) => {
    calls.push([command, args]);
    return {
      onData(callback) { onData = callback; return { dispose() {} }; },
      onExit(callback) { onExit = callback; return { dispose() {} }; },
      write(data) { calls.push(['input', data]); },
      resize(cols, rows) { calls.push(['resize', cols, rows]); },
      kill() { calls.push(['detach']); },
    };
  } });
  server.listen(0, '127.0.0.1'); await once(server, 'listening');
  t.after(() => server.stop());
  const base = `http://127.0.0.1:${server.address().port}`;
  assert.deepEqual(await (await fetch(`${base}/api/terminal/sessions`)).json(), { sessions });
  assert.equal((await fetch(`${base}/api/terminal/sessions`, { headers: { origin: 'http://evil' } })).status, 403);
  assert.equal((await fetch(`${base}/api/terminal/shell`, { method: 'POST', headers: { origin: 'http://evil' } })).status, 403);
  assert.deepEqual(await (await fetch(`${base}/api/terminal/shell`, { method: 'POST', headers: { origin: base } })).json(), { session: 's8-host-shell' });
  const wsUrl = base.replace('http:', 'ws:') + '/api/terminal/ws?session=s8-main';
  const denied = new WebSocket(wsUrl, { origin: 'http://evil' });
  await assert.rejects(once(denied, 'open'), /403/);
  const invalid = new WebSocket(wsUrl.replace('s8-main', 'shell'), { origin: base });
  await assert.rejects(once(invalid, 'open'), /404/);
  for (const name of ['phcms:0', 'phcms.0', 'phcms\nother']) {
    const invalid = new WebSocket(wsUrl.replace('s8-main', encodeURIComponent(name)), { origin: base });
    await assert.rejects(once(invalid, 'open'), /404/);
  }
  const client = await connect(wsUrl, base);
  const output = once(client, 'message'); onData('hello');
  assert.equal((await output)[0].toString(), 'hello');
  client.send(JSON.stringify({ type: 'input', data: 'abc' }));
  client.send(JSON.stringify({ type: 'resize', cols: 100, rows: 30 }));
  await new Promise(resolve => setTimeout(resolve, 20));
  assert.deepEqual(calls.slice(0, 3), [['tmux', ['attach-session', '-t', '=s8-main']], ['input', 'abc'], ['resize', 100, 30]]);
  client.send(JSON.stringify({ type: 'resize', cols: 999999, rows: 30 }));
  assert.equal((await once(client, 'close'))[0], 1008);
  await new Promise(resolve => setTimeout(resolve, 10));
  assert.ok(calls.some(call => call[0] === 'detach'));
  const again = await connect(wsUrl, base);
  const closed = once(again, 'close'); onExit(); await closed;
  for (const name of sessions.slice(1)) {
    const service = await connect(wsUrl.replace('s8-main', encodeURIComponent(name)), base);
    assert.deepEqual(calls.at(-1), ['tmux', ['attach-session', '-t', '=' + name]]);
    const closed = once(service, 'close'); service.close(); await closed;
  }
});
