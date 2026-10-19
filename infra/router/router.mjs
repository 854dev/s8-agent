#!/usr/bin/env node
// S8 라우터. 공개 주소 하나로 받은 요청을 경로별로 로컬 서비스(frontend·KB Browser·터미널·콘솔·PH-CMS)에 전달한다.
// 의존성 없이 Node 표준 라이브러리만 쓴다. 바인딩 주소는 s8-config.yml의 network(S8_BIND_IP·S8_HTTP_PORT)를 따른다.
import http from 'node:http';
import { isIP } from 'node:net';
import { pathToFileURL } from 'node:url';

const MAX_BODY = 200 * 1024 * 1024;
const SECURITY_HEADERS = { 'x-content-type-options': 'nosniff', 'x-frame-options': 'SAMEORIGIN', 'referrer-policy': 'same-origin' };
// 연결마다 다시 써야 하는 hop-by-hop 헤더.
const HOP = new Set(['connection', 'keep-alive', 'proxy-connection', 'transfer-encoding', 'te', 'trailer', 'upgrade']);

export const DEFAULT_UPSTREAMS = { app: 4178, kb: 8787, terminal: 8790, phcms: 8000, console: 8791 };

/** 경로를 { upstream, path, prefix }로 바꾼다. 맞는 경로가 없으면 null. */
export function route(pathname) {
  if (pathname === '/api/docs/health') return { upstream: 'kb', path: '/health' };
  if (pathname.startsWith('/api/docs/') || pathname.startsWith('/api/files/upload')) return { upstream: 'kb' };
  if (pathname.startsWith('/api/terminal/')) return { upstream: 'terminal' };
  if (pathname.startsWith('/api/projectman/')) return { upstream: 'console' };
  if (pathname.startsWith('/api/v2/')) return { upstream: 'phcms' };
  if (pathname.startsWith('/s8/')) return { upstream: 'app', prefix: '/s8' };
  return null;
}

function forwardHeaders(req, target) {
  const headers = {};
  for (const [name, value] of Object.entries(req.headers)) if (!HOP.has(name)) headers[name] = value;
  const address = req.socket.remoteAddress ?? '';
  headers['x-real-ip'] = address;
  headers['x-forwarded-for'] = req.headers['x-forwarded-for'] ? `${req.headers['x-forwarded-for']}, ${address}` : address;
  headers['x-forwarded-proto'] = 'http';
  if (target.prefix) headers['x-forwarded-prefix'] = target.prefix;
  return headers;
}

function send(res, status, type, body) {
  res.writeHead(status, { ...SECURITY_HEADERS, 'content-type': type, 'content-length': Buffer.byteLength(body) });
  res.end(body);
}

export function createRouter({ upstreams = DEFAULT_UPSTREAMS, host = '127.0.0.1' } = {}) {
  const server = http.createServer((req, res) => {
    const url = new URL(req.url, 'http://router.invalid');
    if (url.pathname === '/health') return send(res, 200, 'application/json', '{"status":"ok","router":"s8"}');
    if (url.pathname === '/') return send(res, 200, 'text/plain', '854_md router is running\n');
    const target = route(url.pathname);
    if (!target) return send(res, 404, 'text/plain', 'Not found\n');
    if (Number(req.headers['content-length'] ?? 0) > MAX_BODY) return send(res, 413, 'text/plain', 'Request too large\n');
    const upstream = http.request({ host, port: upstreams[target.upstream], method: req.method, path: (target.path ?? url.pathname) + url.search, headers: forwardHeaders(req, target) }, response => {
      const headers = { ...SECURITY_HEADERS };
      for (const [name, value] of Object.entries(response.headers)) if (!HOP.has(name)) headers[name] = value;
      res.writeHead(response.statusCode, response.statusMessage, headers);
      response.pipe(res);
    });
    upstream.on('error', () => { if (!res.headersSent) send(res, 502, 'text/plain', 'Bad gateway\n'); else res.destroy(); });
    req.pipe(upstream);
  });

  // WebSocket(웹 터미널·Vite HMR)은 연결을 그대로 이어 준다.
  server.on('upgrade', (req, socket, head) => {
    const url = new URL(req.url, 'http://router.invalid');
    const target = route(url.pathname);
    if (!target || !['terminal', 'app'].includes(target.upstream)) return socket.destroy();
    const headers = { ...forwardHeaders(req, target), connection: 'Upgrade', upgrade: req.headers.upgrade };
    const upstream = http.request({ host, port: upstreams[target.upstream], method: req.method, path: url.pathname + url.search, headers });
    upstream.on('upgrade', (response, upstreamSocket, upstreamHead) => {
      const lines = [`HTTP/1.1 ${response.statusCode} ${response.statusMessage}`];
      for (let i = 0; i < response.rawHeaders.length; i += 2) lines.push(`${response.rawHeaders[i]}: ${response.rawHeaders[i + 1]}`);
      socket.write(`${lines.join('\r\n')}\r\n\r\n`);
      if (upstreamHead.length) socket.write(upstreamHead);
      if (head.length) upstreamSocket.write(head);
      upstreamSocket.pipe(socket).pipe(upstreamSocket);
      // 한쪽이 끊기면 양쪽을 닫는다. HTTP 서버 소켓은 반쯤 열린 상태로 남을 수 있어 end도 끊김으로 본다.
      const close = () => { socket.destroy(); upstreamSocket.destroy(); };
      for (const side of [socket, upstreamSocket]) for (const event of ['end', 'close', 'error']) side.on(event, close);
    });
    // 업그레이드를 거절한 응답은 그대로 돌려주고 닫는다.
    upstream.on('response', response => {
      socket.end(`HTTP/1.1 ${response.statusCode} ${response.statusMessage}\r\nconnection: close\r\n\r\n`);
      response.resume();
    });
    upstream.on('error', () => socket.destroy());
    upstream.end();
  });
  // 업로드와 장시간 연결을 끊지 않는다. 헤더는 제한 시간 안에 받아야 한다.
  server.requestTimeout = 0;
  server.headersTimeout = 60_000;
  return server;
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? '').href) {
  const bind = process.env.S8_BIND_IP || '127.0.0.1';
  const port = Number(process.env.S8_HTTP_PORT || 80);
  if (!isIP(bind) || bind === '0.0.0.0' || bind === '::') throw new Error('S8_BIND_IP must be a specific IP address');
  const server = createRouter();
  server.on('error', error => {
    console.error(error.code === 'EACCES'
      ? `[router] ${bind}:${port}에 바인딩할 권한이 없습니다. README의 '80번 포트 허용'(sysctl net.ipv4.ip_unprivileged_port_start)을 적용하세요.`
      : `[router] ${error.message}`);
    process.exit(1);
  });
  server.listen(port, bind, () => console.log(`S8 router (Node): http://${bind}:${port}`));
  for (const signal of ['SIGINT', 'SIGTERM']) process.once(signal, () => { server.close(); server.closeAllConnections(); });
}
