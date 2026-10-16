import http from 'node:http';
import { fileURLToPath } from 'node:url';
import { WebSocketServer, WebSocket } from 'ws';
import * as pty from 'node-pty';
import { listTerminalSessions, ensureShell, validTerminalSession } from './sessions.mjs';

export function sameOrigin(req, required = false) {
  let hostname;
  try { hostname = new URL(`http://${req.headers.host}`).hostname; } catch { return false; }
  const parts = hostname.split('.').map(Number);
  const tailnet = parts.length === 4 && parts.every(part => Number.isInteger(part) && part >= 0 && part <= 255)
    && parts[0] === 100 && parts[1] >= 64 && parts[1] <= 127;
  // Reject arbitrary Host names as well as cross-origin requests (DNS rebinding).
  if (!tailnet && !['127.0.0.1', 'localhost', '[::1]'].includes(hostname) && !hostname.startsWith('[fd7a:115c:a1e0:')) return false;
  const origin = req.headers.origin;
  if (!origin) return !required;
  return origin === `${req.headers['x-forwarded-proto'] === 'https' ? 'https' : 'http'}://${req.headers.host}`;
}
export function size(value) {
  return Number.isInteger(value?.cols) && value.cols >= 2 && value.cols <= 300
    && Number.isInteger(value?.rows) && value.rows >= 2 && value.rows <= 150;
}
export function createGateway({ sessions = listTerminalSessions, shell = ensureShell, spawn = pty.spawn } = {}) {
  const server = http.createServer(async (req, res) => {
    res.setHeader('Cache-Control', 'no-store');
    res.setHeader('Content-Type', 'application/json');
    if (!sameOrigin(req)) { res.writeHead(403); return res.end('{}'); }
    if (req.method === 'GET' && req.url === '/api/terminal/health') return res.end('{"status":"ok"}');
    if (req.method === 'POST' && req.url === '/api/terminal/shell') {
      if (!sameOrigin(req, true)) { res.writeHead(403); return res.end('{}'); }
      try { return res.end(JSON.stringify({ session: await shell() })); }
      catch { res.writeHead(503); return res.end('{"error":"shell unavailable"}'); }
    }
    if (req.method === 'GET' && req.url === '/api/terminal/sessions') {
      try { return res.end(JSON.stringify({ sessions: await sessions() })); }
      catch { res.writeHead(503); return res.end('{"error":"tmux unavailable"}'); }
    }
    res.writeHead(404); res.end('{}');
  });
  const ws = new WebSocketServer({ noServer: true, maxPayload: 16384, perMessageDeflate: false });
  let pending = 0;
  server.on('upgrade', async (req, socket, head) => {
    const reject = code => { socket.end(`HTTP/1.1 ${code}\r\nConnection: close\r\n\r\n`); };
    if (!sameOrigin(req, true)) return reject('403 Forbidden');
    if (ws.clients.size + pending >= 8) return reject('503 Service Unavailable');
    pending++;
    try {
      const url = new URL(req.url, 'http://localhost');
      const session = url.searchParams.get('session');
      if (url.pathname !== '/api/terminal/ws' || !validTerminalSession(session) || !(await sessions()).includes(session)) return reject('404 Not Found');
      if (socket.destroyed) return;
      ws.handleUpgrade(req, socket, head, client => ws.emit('connection', client, session));
    } catch { reject('503 Service Unavailable'); }
    finally { pending--; }
  });
  ws.on('connection', (client, session) => {
    let terminal;
    try {
      terminal = spawn('tmux', ['attach-session', '-t', `=${session}`], {
        name: 'xterm-256color', cols: 80, rows: 24,
        env: { ...process.env, TMUX: '', TERM: 'xterm-256color' },
      });
    } catch { client.close(1011, 'tmux attach failed'); return; }
    const data = terminal.onData(text => {
      if (client.readyState !== WebSocket.OPEN) return;
      if (client.bufferedAmount > 1024 * 1024) { client.close(1013, 'Slow client'); return; }
      client.send(text);
    });
    const exit = terminal.onExit(() => client.close(1000, 'Session disconnected'));
    const heartbeat = setInterval(() => {
      if (!client.alive) return client.terminate();
      client.alive = false; client.ping();
    }, 30000);
    client.alive = true;
    client.on('pong', () => { client.alive = true; });
    client.on('message', (raw, binary) => {
      try {
        if (binary) throw new Error();
        const message = JSON.parse(raw.toString());
        if (message.type === 'input' && typeof message.data === 'string' && message.data.length <= 8192) terminal.write(message.data);
        else if (message.type === 'resize' && size(message)) terminal.resize(message.cols, message.rows);
        else throw new Error();
      } catch { client.close(1008, 'Invalid terminal message'); }
    });
    client.on('error', () => {});
    client.on('close', () => { clearInterval(heartbeat); data.dispose(); exit.dispose(); terminal.kill(); });
  });
  server.stop = () => { for (const client of ws.clients) client.terminate(); server.close(); server.closeAllConnections(); };
  server.on('close', () => ws.close());
  return server;
}
if (process.argv[1] === fileURLToPath(import.meta.url)) {
  await ensureShell();
  const server = createGateway();
  const hostIndex = process.argv.indexOf('--host');
  const host = hostIndex < 0 ? '127.0.0.1' : process.argv[hostIndex + 1];
  if (!host || host === '0.0.0.0' || host === '::') throw new Error('터미널 백엔드 전체 인터페이스 노출은 허용하지 않습니다.');
  server.listen(8790, host, () => console.log(`Terminal gateway: ${host}:8790`));
  const stop = () => server.stop();
  process.on('SIGTERM', stop); process.on('SIGINT', stop);
}
