import http from 'node:http';
import path from 'node:path';
import { readFile, lstat } from 'node:fs/promises';
import { ProjectmanClient } from './projectman-client.ts';
import { hasReviewedPreflight } from './projectman-preflight.mjs';
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
      if (req.method === 'POST' && url.pathname === '/api/projectman/items') {
        const input = await body(req);
        const parents = { workspace: null, project: 'workspace', task: 'project', subtask: 'task' };
        if (!Object.hasOwn(parents, input.type) || typeof input.title !== 'string' || !input.title.trim() || input.title.length > 200 || typeof input.text !== 'string' || input.text.length > 50000 ||
          (input.type === 'workspace' ? input.parentUid : typeof input.parentUid !== 'string') ||
          (input.type === 'project' && (typeof input.repoPath !== 'string' || !path.isAbsolute(input.repoPath))) ||
          Object.keys(input).some(key => !['type', 'parentUid', 'title', 'text', 'repoPath'].includes(key))) return json(res, 400, { error: '유형·제목·상위 항목과 프로젝트 저장소 절대 경로를 확인하세요.' });
        if (parents[input.type] && (await client.get(input.parentUid)).type !== parents[input.type]) return json(res, 400, { error: '상위 항목의 유형이 맞지 않습니다.' });
        const created = input.type === 'workspace' ? await client.createWorkspace(input.title.trim(), input.text) : await client.create(input.parentUid, input.type, input.title.trim(), input.text, [], input.repoPath);
        return json(res, 201, { item: created });
      }
      const item = /^\/api\/projectman\/items\/([a-zA-Z0-9_-]+)$/.exec(url.pathname);
      if (item && ['PATCH', 'DELETE'].includes(req.method)) {
        const input = await body(req);
        if (typeof input.title !== 'string' || !input.title.trim() || input.title.length > 200 || Object.keys(input).some(key => !['title', ...(req.method === 'PATCH' ? ['text'] : [])].includes(key))) return json(res, 400, { error: '제목을 확인하세요.' });
        if (req.method === 'PATCH') {
          if (typeof input.text !== 'string' || input.text.length > 50000) return json(res, 400, { error: '본문을 확인하세요.' });
          return json(res, 200, { item: await client.editResource(item[1], input.title.trim(), input.text) });
        }
        if ((await client.capabilities()).safeResourceDelete !== true) return json(res, 503, { error: 'PH-CMS에 안전한 리소스 삭제 지원을 먼저 적용해야 합니다.' });
        const current = await client.get(item[1]);
        if (input.title !== current.title) return json(res, 409, { error: '삭제할 항목의 현재 제목을 정확히 입력하세요.' });
        await client.deleteResource(current.uid);
        return json(res, 200, { deleted: true });
      }
      if (req.method === 'GET' && item) {
        const content = await client.get(item[1]);
        const workflow = ['task', 'subtask'].includes(content.type) ? await client.getWorkflow(content.uid) : null;
        return json(res, 200, { item: content, execution: workflow ? { ...workflow, preflightReviewed: hasReviewedPreflight(content, workflow.workflow) } : null, logs: await client.list('work_log', content.uid) });
      }
      const action = /^\/api\/projectman\/items\/([a-zA-Z0-9_-]+)\/workflow$/.exec(url.pathname);
      if (req.method === 'POST' && action) {
        const input = await body(req);
        if (!['authorize', 'draft', 'decide', 'cancel', 'complete', 'recover', 'retry'].includes(input.action)) return json(res, 400, { error: '지원하지 않는 사용자 결정입니다.' });
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
      const messages = { 400: '요청을 확인하세요.', 401: 'PH-CMS 사용자 로그인이 필요합니다.', 403: '이 작업을 확인하거나 결정할 권한이 없습니다.', 404: '대상을 찾지 못했습니다.', 409: '하위 리소스를 먼저 삭제하고 실행을 종료하세요. 작업 또는 결정이 변경된 경우 새로고침 후 다시 확인하세요.', 413: '요청 또는 기록이 너무 큽니다.' };
      return json(res, status >= 400 && status <= 599 ? status : 503, { error: messages[status] ?? 'Projectman 연결 또는 기록 조회에 실패했습니다.' });
    }
  });
}
