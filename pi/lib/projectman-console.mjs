import http from 'node:http';
import path from 'node:path';
import { readFile, lstat } from 'node:fs/promises';
import { ProjectmanClient } from './projectman-client.ts';
import { consoleSessions } from './projectman-session.mjs';

const json = (res, status, data) => { res.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store', 'X-Content-Type-Options': 'nosniff' }); res.end(JSON.stringify(data)); };
async function body(req) {
  let value = ''; for await (const chunk of req) { value += chunk; if (Buffer.byteLength(value) > 64000) throw Object.assign(new Error(), { status: 413 }); }
  try { const parsed = JSON.parse(value); if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) throw new Error(); return parsed; } catch { throw Object.assign(new Error(), { status: 400 }); }
}
function sameOrigin(req) {
  if (!req.headers.host || !req.headers.origin) return false;
  try { const origin = new URL(req.headers.origin); return ['http:', 'https:'].includes(origin.protocol) && origin.host === req.headers.host; } catch { return false; }
}

export function createProjectmanConsole({ root, baseUrl = process.env.PHCMS_API_URL ?? 'http://127.0.0.1:8000/api/v2', fetchImpl = fetch, authFactory, clientFactory = token => new ProjectmanClient(baseUrl, token, fetchImpl) }) {
  const sessions = consoleSessions({ baseUrl, clientFactory, authFactory });
  return http.createServer(async (req, res) => {
    try {
      const url = new URL(req.url, 'http://localhost');
      if (req.method !== 'GET' && !sameOrigin(req)) return json(res, 403, { error: '동일 출처에서만 결정할 수 있습니다.' });
      if (req.method === 'POST' && url.pathname === '/api/projectman/login') {
        const input = await body(req);
        if (typeof input.email !== 'string' || typeof input.password !== 'string' || input.email.length > 200 || input.password.length > 1000) return json(res, 400, { error: '이메일과 비밀번호를 입력하세요.' });
        await sessions.login(req, res, { email: input.email, password: input.password });
        return json(res, 200, { authenticated: true });
      }
      if (req.method === 'POST' && url.pathname === '/api/projectman/logout') {
        sessions.logout(req, res);
        return json(res, 200, { authenticated: false });
      }
      const client = await sessions.client(req, res);
      if (req.method === 'GET' && url.pathname === '/api/projectman/session') {
        await client.list('workspace'); return json(res, 200, { authenticated: true });
      }
      if (req.method === 'GET' && url.pathname === '/api/projectman/items') {
        const type = url.searchParams.get('type') ?? 'task';
        if (!['task', 'subtask', 'workspace', 'project'].includes(type)) return json(res, 400, { error: '잘못된 작업 유형입니다.' });
        return json(res, 200, { items: await client.list(type, url.searchParams.get('parentUid') ?? undefined) });
      }
      const item = /^\/api\/projectman\/items\/([a-zA-Z0-9_-]+)$/.exec(url.pathname);
      if (req.method === 'GET' && item) {
        const content = await client.get(item[1]);
        const workflow = ['task', 'subtask'].includes(content.type) ? await client.getWorkflow(content.uid) : null;
        return json(res, 200, { item: content, execution: workflow, logs: await client.list('work_log', content.uid) });
      }
      const action = /^\/api\/projectman\/items\/([a-zA-Z0-9_-]+)\/workflow$/.exec(url.pathname);
      if (req.method === 'POST' && action) {
        const input = await body(req);
        if (!['authorize', 'draft', 'decide', 'cancel', 'complete', 'recover'].includes(input.action)) return json(res, 400, { error: '지원하지 않는 사용자 결정입니다.' });
        return json(res, 200, await client.workflow(action[1], input));
      }
      const events = /^\/api\/projectman\/runs\/([a-f0-9-]{36})\/events$/.exec(url.pathname);
      const patch = /^\/api\/projectman\/runs\/([a-f0-9-]{36})\/patch$/.exec(url.pathname);
      if (req.method === 'GET' && patch) {
        const directory = path.join(root, '.s8-runtime/runs', patch[1]);
        if (!(await lstat(directory)).isDirectory()) return json(res, 404, { error: '실행을 찾지 못했습니다.' });
        const request = JSON.parse(await readFile(path.join(directory, 'request.json'), 'utf8'));
        await client.getWorkflow(request.task.uid);
        const file = path.join(directory, 'changes.patch'), stat = await lstat(file);
        if (!stat.isFile() || stat.nlink !== 1 || stat.size > 2000000) return json(res, 413, { error: '패치 크기를 확인하세요.' });
        res.writeHead(200, { 'Content-Type': 'text/plain; charset=utf-8', 'Cache-Control': 'no-store', 'Content-Disposition': `attachment; filename="${patch[1]}.patch"`, 'X-Content-Type-Options': 'nosniff' });
        return res.end(await readFile(file));
      }
      if (req.method === 'GET' && events) {
        const directory = path.join(root, '.s8-runtime/runs', events[1]);
        if (!(await lstat(directory)).isDirectory()) return json(res, 404, { error: '실행을 찾지 못했습니다.' });
        const request = JSON.parse(await readFile(path.join(directory, 'request.json'), 'utf8'));
        await client.getWorkflow(request.task.uid);
        const file = path.join(directory, 'developer.events.jsonl'), stat = await lstat(file);
        if (!stat.isFile() || stat.nlink !== 1 || stat.size > 10000000) return json(res, 413, { error: '실행 기록을 분할해 확인해야 합니다.' });
        const offset = Number(url.searchParams.get('offset') ?? 0);
        if (!Number.isSafeInteger(offset) || offset < 0) return json(res, 400, { error: '잘못된 페이지입니다.' });
        const lines = (await readFile(file, 'utf8')).split('\n').filter(Boolean);
        return json(res, 200, { events: lines.slice(offset, offset + 30).map(line => JSON.parse(line)), nextOffset: offset + 30 < lines.length ? offset + 30 : null });
      }
      return json(res, 404, { error: '경로를 찾지 못했습니다.' });
    } catch (error) {
      const upstream = /HTTP (\d+)/.exec(error.message ?? '');
      const status = error.status ?? (upstream ? Number(upstream[1]) : error.code === 'ENOENT' ? 404 : 503);
      const messages = { 400: '요청을 확인하세요.', 401: 'PH-CMS 사용자 로그인이 필요합니다.', 403: '이 작업을 확인하거나 결정할 권한이 없습니다.', 404: '대상을 찾지 못했습니다.', 409: '작업 또는 결정이 변경됐습니다. 새로고침 후 다시 확인하세요.', 413: '요청 또는 기록이 너무 큽니다.' };
      return json(res, status >= 400 && status <= 599 ? status : 503, { error: messages[status] ?? 'Projectman 연결 또는 기록 조회에 실패했습니다.' });
    }
  });
}
