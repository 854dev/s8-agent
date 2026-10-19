import http from 'node:http';
import path from 'node:path';
import { readFile, lstat } from 'node:fs/promises';
import { ProjectmanClient } from './client.ts';
import { hasReviewedPreflight } from './preflight.mjs';
import { consoleSessions } from './session.mjs';
import { submitCompletionReview } from './completion-review.mjs';
import { readEventPage } from './events.mjs';
import { finishStoppedRun } from '../agent/finish.mjs';
import { loadS8Config, WORKER_MODES } from '../config/s8-config.mjs';
import { queueInstruction, setWorkerMode, workerStatuses } from '../agent/resident.mjs';

const json = (res, status, data) => { res.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store', 'X-Content-Type-Options': 'nosniff' }); res.end(JSON.stringify(data)); };
async function body(req) {
  // 50,000 UTF-16 units can require 300KB when JSON-escaped, plus envelope fields.
  const chunks = []; let bytes = 0;
  for await (const chunk of req) { bytes += chunk.length; if (bytes > 384000) throw Object.assign(new Error(), { status: 413 }); chunks.push(chunk); }
  try { const parsed = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(Buffer.concat(chunks))); if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) throw new Error(); return parsed; } catch { throw Object.assign(new Error(), { status: 400 }); }
}
function sameOrigin(req) {
  if (!req.headers.host || !req.headers.origin) return false;
  try { const origin = new URL(req.headers.origin); return ['http:', 'https:'].includes(origin.protocol) && origin.host === req.headers.host; } catch { return false; }
}

// agentClientFactory: 멈춘 실행 마무리 보고용 에이전트 클라이언트. 서버는 run을 claim한 에이전트의 보고만 받으므로 사람 세션이 아닌 서비스 키를 쓴다.
const agentFromEnv = (baseUrl, fetchImpl) => () => {
  if (!process.env.PHCMS_ACCESS_TOKEN) throw Object.assign(new Error(), { status: 503, code: 'AGENT_KEY_MISSING' });
  return new ProjectmanClient(baseUrl, process.env.PHCMS_ACCESS_TOKEN, fetchImpl);
};

export function createProjectmanConsole({ root, baseUrl = process.env.PHCMS_API_URL ?? 'http://127.0.0.1:8000/api/v2', fetchImpl = fetch, authFactory, clientFactory = token => new ProjectmanClient(baseUrl, token, fetchImpl), agentClientFactory = agentFromEnv(baseUrl, fetchImpl) }) {
  const sessions = consoleSessions({ baseUrl, clientFactory, authFactory });
  async function handle(req, res, renewed = false) {
    let authenticated = false;
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
      const client = await sessions.client(req, res, { forceRefresh: renewed });
      authenticated = true;
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
      if (item && req.method === 'PATCH') {
        const input = await body(req);
        if (typeof input.title !== 'string' || !input.title.trim() || input.title.length > 200 || Object.keys(input).some(key => !['title', 'text'].includes(key))) return json(res, 400, { error: '제목을 확인하세요.' });
        if (typeof input.text !== 'string' || input.text.length > 50000) return json(res, 400, { error: '본문을 확인하세요.' });
        return json(res, 200, { item: await client.editResource(item[1], input.title.trim(), input.text) });
      }
      if (item && req.method === 'DELETE') {
        if (url.searchParams.get('cascade') !== 'true') return json(res, 400, { code: 'CASCADE_CONFIRMATION_REQUIRED', error: '하위 자원 포함 삭제를 확인해야 합니다. 화면을 새로고침한 뒤 다시 삭제하세요.' });
        if ((await client.capabilities()).cascadeResourceDelete !== true) return json(res, 503, { code: 'CASCADE_DELETE_UNAVAILABLE', error: 'PH-CMS에 하위 자원 일괄 삭제 지원을 먼저 적용해야 합니다.' });
        return json(res, 200, { deleted: true, ...await client.deleteResource(item[1]) });
      }
      if (req.method === 'GET' && item) {
        const content = await client.get(item[1]);
        const workflow = ['task', 'subtask'].includes(content.type) ? await client.getWorkflow(content.uid) : null;
        return json(res, 200, { item: content, execution: workflow ? { ...workflow, preflightReviewed: hasReviewedPreflight(content, workflow.workflow) } : null, logs: await client.list('work_log', content.uid) });
      }
      const action = /^\/api\/projectman\/items\/([a-zA-Z0-9_-]+)\/workflow$/.exec(url.pathname);
      if (req.method === 'POST' && action) {
        const input = await body(req);
        if (!['authorize', 'draft', 'decide', 'complete', 'cancel', 'recover', 'retry'].includes(input.action)) return json(res, 400, { error: '지원하지 않는 사용자 결정입니다.' });
        return json(res, 200, input.action === 'complete' ? await submitCompletionReview({ root, client, uid: action[1], input }) : await client.workflow(action[1], input));
      }
      const finish = /^\/api\/projectman\/items\/([a-zA-Z0-9_-]+)\/finish-stopped-run$/.exec(url.pathname);
      if (req.method === 'POST' && finish) {
        const input = await body(req);
        if (input.confirmStopped !== true || typeof input.runId !== 'string' || Object.keys(input).some(key => !['runId', 'confirmStopped'].includes(key))) return json(res, 400, { error: '모든 장비에서 실행이 멈췄는지 확인하고 실행 ID를 지정하세요.' });
        // 사람 세션으로 작업 접근 권한과 현재 실행을 확인한 뒤, 보고는 claim한 에이전트 키로 보낸다.
        if ((await client.getWorkflow(finish[1])).workflow?.run?.id !== input.runId) return json(res, 409, { error: '현재 실행이 바뀌었습니다. 새로고침 후 다시 확인하세요.' });
        try { return json(res, 200, await finishStoppedRun({ root, client: agentClientFactory(), uid: finish[1], runId: input.runId, confirmed: true })); }
        catch (error) { if (error.code === 'FINISH_REFUSED') return json(res, 409, { code: error.code, error: error.message }); throw error; }
      }
      // 상주 워커: 목록·모드 변경·작업 지시. 워커 목록은 s8-config.yml의 workers다.
      if (req.method === 'GET' && url.pathname === '/api/projectman/workers') {
        return json(res, 200, { workers: await workerStatuses(root, loadS8Config(root).workers) });
      }
      const workerAction = /^\/api\/projectman\/workers\/([a-z][a-z0-9-]{0,31})\/(mode|instructions)$/.exec(url.pathname);
      if (req.method === 'POST' && workerAction) {
        const worker = loadS8Config(root).workers.find(item => item.id === workerAction[1]);
        if (!worker) return json(res, 404, { error: 's8-config.yml에 없는 워커입니다.' });
        const input = await body(req);
        if (workerAction[2] === 'mode') {
          if (Object.keys(input).some(key => key !== 'mode') || !(input.mode === null || WORKER_MODES.includes(input.mode))) return json(res, 400, { error: `모드는 ${WORKER_MODES.join(', ')} 또는 null(설정값)입니다.` });
          await setWorkerMode(root, worker.id, input.mode);
          return json(res, 200, { worker: (await workerStatuses(root, [worker]))[0] });
        }
        if (Object.keys(input).some(key => key !== 'uid') || typeof input.uid !== 'string' || !/^[a-zA-Z0-9_-]{1,120}$/.test(input.uid)) return json(res, 400, { error: '작업 UID를 확인하세요.' });
        // 사람 세션으로 작업을 확인한다. 실행은 워커가 claim할 때 PH-CMS가 다시 검사한다.
        const task = await client.getWorkflow(input.uid);
        if (task.state !== 'ready' || !task.workflow?.grant || task.workflow.run?.status === 'running') return json(res, 409, { error: '사람이 계획을 확정한 실행 대기(ready) 작업만 지시할 수 있습니다.' });
        const assignee = task.workflow.assignment?.assignee ?? task.workflow.spec?.assignee;
        if (assignee && assignee !== worker.id) return json(res, 409, { error: `${assignee}에게 배정된 작업입니다.` });
        await queueInstruction(root, worker.id, input.uid, 'console');
        return json(res, 202, { worker: (await workerStatuses(root, [worker]))[0] });
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
        const execution = await client.getWorkflow(request.task.uid);
        const offset = Number(url.searchParams.get('offset') ?? 0);
        const cursor = url.searchParams.has('cursor') ? Number(url.searchParams.get('cursor')) : undefined;
        return json(res, 200, await readEventPage(path.join(directory, 'developer.events.jsonl'), { offset, cursor, follow: execution.workflow?.run?.id === events[1] && execution.workflow.run.status === 'running' }));
      }
      return json(res, 404, { error: '경로를 찾지 못했습니다.' });
    } catch (error) {
      const upstream = /HTTP (\d+)/.exec(error.message ?? '');
      const status = error.status ?? (upstream ? Number(upstream[1]) : error.code === 'ENOENT' ? 404 : 503);
      if (status === 401 && authenticated && !renewed) {
        if (req.method === 'GET') return handle(req, res, true);
        // Never replay a write: refresh cookies, but preserve the original request ID for a manual retry.
        try {
          await sessions.client(req, res, { forceRefresh: true });
          return json(res, 401, { code: 'SESSION_RENEWED', error: '세션을 갱신했습니다. 쓰기는 자동 재전송하지 않았습니다. 반영 여부를 확인한 뒤 같은 요청으로 다시 시도하세요.' });
        } catch (refreshError) {
          const refreshStatus = refreshError.status ?? 503;
          return json(res, refreshStatus, { error: refreshStatus === 401 ? 'PH-CMS 사용자 로그인이 필요합니다.' : '세션 갱신에 실패했습니다. 쓰기 반영 여부를 확인하고 다시 시도하세요.' });
        }
      }
      const reasons = {
        WORKFLOW_FROZEN: '위임된 작업의 제목·본문은 직접 수정할 수 없습니다. 매니저와 실행 계획을 수정하세요.',
        CHILD_RESOURCES_EXIST: '하위 리소스를 먼저 삭제하세요. 자동 연쇄 삭제는 지원하지 않습니다.',
        EXECUTION_NOT_FINISHED: '위임된 작업은 완료·취소 상태이고 실행이 종료되어야 삭제할 수 있습니다.',
        PARENT_CHANGED: '상위 리소스가 삭제됐습니다. 목록을 새로고침하세요.',
        TREE_EXECUTION_ACTIVE: '하위 자원에 실행 중이거나 종료 확인이 안 된 작업이 있습니다. 실행 종료 후 다시 삭제하세요.',
        TREE_HAS_DEPENDENTS: '삭제 범위 밖의 미완료 작업이 이 자원을 선행 항목으로 참조합니다. 해당 작업의 계획을 먼저 수정하세요.',
        TREE_TOO_LARGE: '삭제 범위가 5,000개 기록을 초과합니다. 작은 하위 자원 단위로 나누어 삭제하세요.',
        DEPENDENCY_CHANGED: '선행 작업이 없거나 삭제됐습니다. 목록과 계획을 새로 확인하세요.',
        PROJECT_ALREADY_EXISTS: '이 워크스페이스에 같은 저장소의 프로젝트가 이미 있습니다. 기존 프로젝트를 선택하세요.',
        JSON_BODY_REQUIRED: '본문 없는 요청에 JSON 헤더가 전송됐습니다. 콘솔 API 버전을 확인하세요.',
        INVALID_CURSOR: '기록 페이지 위치가 올바르지 않습니다. 실행 기록을 처음부터 다시 조회하세요.',
        LOG_CHANGED: '실행 기록이 교체되거나 줄었습니다. 처음부터 다시 조회하세요.',
        LOG_CORRUPT: '완료된 실행 기록 줄이 손상됐습니다. 기록 파일을 점검하세요.',
        LOG_LINE_TOO_LARGE: '단일 실행 기록이 2MB를 초과했습니다. 기록 생성 측에서 항목을 분할해야 합니다.',
        AGENT_KEY_MISSING: '콘솔 서버에 에이전트 서비스 키(PHCMS_ACCESS_TOKEN)가 없습니다. .env를 설정하고 콘솔을 다시 시작하세요.',
        LOG_CURSOR_REQUIRED: '오래된 페이지 방식의 조회 범위를 초과했습니다. 화면을 새로고침해 커서 방식으로 조회하세요.',
      };
      const messages = { 400: '요청을 확인하세요.', 401: 'PH-CMS 사용자 로그인이 필요합니다.', 403: '이 작업을 확인하거나 결정할 권한이 없습니다.', 404: '대상을 찾지 못했습니다.', 409: '하위 리소스를 먼저 삭제하고 실행을 종료하세요. 작업 또는 결정이 변경된 경우 새로고침 후 다시 확인하세요.', 413: '요청 또는 기록이 너무 큽니다.' };
      const reason = Object.hasOwn(reasons, error.code) ? reasons[error.code] : undefined;
      return json(res, status >= 400 && status <= 599 ? status : 503, { error: reason ?? messages[status] ?? 'Projectman 연결 또는 기록 조회에 실패했습니다.', ...(reason ? { code: error.code } : {}) });
    }
  }
  return http.createServer((req, res) => { void handle(req, res).catch(() => res.destroy()); });
}
