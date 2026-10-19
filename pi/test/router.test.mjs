import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import net from 'node:net';
import { once } from 'node:events';
import { createRouter, route } from '../../infra/router/router.mjs';

const listen = async server => { server.listen(0, '127.0.0.1'); await once(server, 'listening'); return server.address().port; };

test('the router maps each path to its local service', () => {
  assert.deepEqual(route('/api/docs/health'), { upstream: 'kb', path: '/health' });
  assert.deepEqual(route('/api/docs/a.md'), { upstream: 'kb' });
  assert.deepEqual(route('/api/files/upload'), { upstream: 'kb' });
  assert.deepEqual(route('/api/terminal/ws'), { upstream: 'terminal' });
  assert.deepEqual(route('/api/projectman/items'), { upstream: 'console' });
  assert.deepEqual(route('/api/v2/projectman/capabilities'), { upstream: 'phcms' });
  assert.deepEqual(route('/s8/terminal'), { upstream: 'app', prefix: '/s8' });
  for (const pathname of ['/api/other', '/s8', '/.env']) assert.equal(route(pathname), null);
});

test('the Node router proxies HTTP and WebSocket traffic with forwarding and security headers', async t => {
  const seen = [];
  const upstream = http.createServer((req, res) => {
    let body = '';
    req.on('data', chunk => { body += chunk; });
    req.on('end', () => { seen.push({ url: req.url, method: req.method, body, host: req.headers.host, prefix: req.headers['x-forwarded-prefix'], forwarded: req.headers['x-forwarded-for'] }); res.writeHead(201, { 'content-type': 'text/plain', 'x-upstream': 'yes' }); res.end('upstream-body'); });
  });
  upstream.on('upgrade', (req, socket) => {
    seen.push({ upgrade: req.url, prefix: req.headers['x-forwarded-prefix'] });
    socket.write('HTTP/1.1 101 Switching Protocols\r\nUpgrade: websocket\r\nConnection: Upgrade\r\n\r\n');
    socket.on('data', data => socket.write(`echo:${data}`));
  });
  const port = await listen(upstream);
  const closed = net.createServer().listen(0, '127.0.0.1'); await once(closed, 'listening');
  const deadPort = closed.address().port; closed.close();
  const router = createRouter({ upstreams: { app: port, kb: port, terminal: port, phcms: port, console: deadPort } });
  const routerPort = await listen(router);
  t.after(() => { router.closeAllConnections(); router.close(); upstream.closeAllConnections(); upstream.close(); });
  const base = `http://127.0.0.1:${routerPort}`;

  const health = await fetch(`${base}/health`);
  assert.equal(health.status, 200); assert.equal((await health.json()).status, 'ok'); assert.equal(health.headers.get('x-frame-options'), 'SAMEORIGIN');
  assert.equal((await fetch(`${base}/nope`)).status, 404);

  const docs = await fetch(`${base}/api/docs/health?x=1`);
  assert.equal(docs.status, 201); assert.equal(await docs.text(), 'upstream-body');
  assert.equal(docs.headers.get('x-upstream'), 'yes'); assert.equal(docs.headers.get('x-content-type-options'), 'nosniff');
  const posted = await fetch(`${base}/s8/api/save`, { method: 'POST', body: 'payload' });
  assert.equal(posted.status, 201);
  assert.deepEqual(seen.map(({ url, method, body, prefix }) => ({ url, method, body, prefix })), [
    { url: '/health?x=1', method: 'GET', body: '', prefix: undefined },
    { url: '/s8/api/save', method: 'POST', body: 'payload', prefix: '/s8' },
  ]);
  assert.equal(seen[1].host, `127.0.0.1:${routerPort}`);
  assert.equal(seen[1].forwarded, '127.0.0.1');
  assert.equal((await fetch(`${base}/api/projectman/session`)).status, 502);

  // WebSocket 업그레이드는 터미널·앱 경로만 이어 준다.
  const socket = net.connect(routerPort, '127.0.0.1'); await once(socket, 'connect');
  socket.write('GET /api/terminal/ws HTTP/1.1\r\nHost: 127.0.0.1\r\nUpgrade: websocket\r\nConnection: Upgrade\r\n\r\n');
  let received = '';
  socket.on('data', data => { received += data; if (received.includes('\r\n\r\n') && !received.includes('echo:')) socket.write('ping'); });
  for (let i = 0; i < 50 && !received.includes('echo:ping'); i++) await new Promise(resolve => setTimeout(resolve, 20));
  assert.match(received, /^HTTP\/1\.1 101/); assert.match(received, /echo:ping/);
  socket.destroy();
  const refused = net.connect(routerPort, '127.0.0.1'); await once(refused, 'connect');
  refused.write('GET /api/docs/x HTTP/1.1\r\nHost: 127.0.0.1\r\nUpgrade: websocket\r\nConnection: Upgrade\r\n\r\n');
  await once(refused, 'close');
  assert.ok(!seen.some(entry => entry.upgrade === '/api/docs/x'));
});
