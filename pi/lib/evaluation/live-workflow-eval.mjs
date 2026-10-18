import { saveJson } from '../storage/json-file.mjs';
import { loadModelRuntime } from '../runtime/model.mjs';
import { mkdir, mkdtemp, writeFile, readFile } from 'node:fs/promises';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import path from 'node:path';
import os from 'node:os';
import { randomUUID } from 'node:crypto';
import { ProjectmanClient } from '../projectman/client.ts';
import { SMOKE_DEPENDENCIES, SMOKE_DEV_DEPENDENCIES } from './development-smoke.mjs';
import { loadDevelopmentPolicy, developmentTick } from '../development/supervisor.mjs';
import { liveConsoleBrowser } from './live-console-browser.mjs';
import { ensureWorkerPool } from '../development/worker-pool.mjs';
import { openManagerSession } from '../manager/session.mjs';

const exec = promisify(execFile);
export async function liveWorkflowEval({ root, baseUrl, managerToken, humanToken, projectUid, humanLogin }) {
  const id = randomUUID(), directory = path.join(root, '.s8-runtime/evals', id);
  await mkdir(directory, { recursive: true, mode: 0o700 });
  const fixture = await mkdtemp(path.join(os.tmpdir(), 's8-live-workflow-')), repo = path.join(fixture, 'repo');
  await mkdir(path.join(repo, 'src'), { recursive: true }); await mkdir(path.join(repo, 'test'));
  await writeFile(path.join(repo, '.gitignore'), 'node_modules/\ndist/\n');
  await writeFile(path.join(repo, 'package.json'), JSON.stringify({ private: true, type: 'module', scripts: { test: 'vitest', build: 'vite build' }, dependencies: SMOKE_DEPENDENCIES, devDependencies: SMOKE_DEV_DEPENDENCIES }));
  await writeFile(path.join(repo, 'index.html'), '<!doctype html><html lang="ko"><head><meta charset="utf-8"><title>Counter</title></head><body><div id="root"></div><script type="module" src="/src/main.jsx"></script></body></html>');
  await writeFile(path.join(repo, 'src/main.jsx'), "import React from 'react'; import {createRoot} from 'react-dom/client'; import App from './App.jsx'; createRoot(document.getElementById('root')).render(<App />);\n");
  await writeFile(path.join(repo, 'src/App.jsx'), "import React from 'react'; export default function App(){ return <main>Counter awaiting implementation</main>; }\n");
  await writeFile(path.join(repo, 'vite.config.js'), "export default { test: { environment: 'jsdom', maxWorkers: 1, fileParallelism: false } };\n");
  await writeFile(path.join(repo, 'test/counter.test.jsx'), "import React from 'react'; import {test,expect,afterEach} from 'vitest'; import {render,screen,cleanup} from '@testing-library/react'; import userEvent from '@testing-library/user-event'; import App from '../src/App.jsx'; afterEach(cleanup); test('initial zero',()=>{render(<App/>);expect(screen.getByLabelText('카운터').textContent.trim()).toBe('0')}); test('increment and reset',async()=>{const u=userEvent.setup();render(<App/>);await u.click(screen.getByRole('button',{name:'증가',exact:true}));expect(screen.getByLabelText('카운터').textContent.trim()).toBe('1');await u.click(screen.getByRole('button',{name:'초기화',exact:true}));expect(screen.getByLabelText('카운터').textContent.trim()).toBe('0')}); test('human decision: minimum is zero',async()=>{const u=userEvent.setup();render(<App/>);await u.click(screen.getByRole('button',{name:'감소',exact:true}));expect(screen.getByLabelText('카운터').textContent.trim()).toBe('0')});\n");
  for (const args of [['init'], ['add', '.'], ['-c', 'user.name=Workflow fixture', '-c', 'user.email=fixture@example.invalid', 'commit', '-m', 'isolated counter fixture']]) await exec('git', args, { cwd: repo });
  const manager = new ProjectmanClient(baseUrl, managerToken), human = new ProjectmanClient(baseUrl, humanToken);
  const runtime = await loadModelRuntime(), policy = await loadDevelopmentPolicy(root);
  const spec = { plan: 'Implement the discussed React/Vite counter with minimum zero; verify tests and build.', decisionRefs: ['conversation:minimum-zero'], repoPath: repo, completionCriteria: ['React + Vite counter, current value aria-label="카운터"', 'Buttons exactly 증가, 감소, 초기화', 'Minimum is zero; negative values are not allowed (confirmed before final approval)', 'Existing independent tests and build pass'], commandNames: ['install', 'test', 'build'], dependsOn: [] };
  let taskUid;
  let browser;
  const evidence = [];
  const check = (name, condition) => { evidence.push({ name, ok: Boolean(condition) }); if (!condition) throw new Error(name); };
  const previousEnv = Object.fromEntries(['PHCMS_API_URL', 'PHCMS_ACCESS_TOKEN', 'S8_PI_CONFIG_ROOT'].map(key => [key, process.env[key]]));
  // Only isolated fixture credentials; restore the process environment on every exit.
  process.env.PHCMS_API_URL = baseUrl;
  process.env.PHCMS_ACCESS_TOKEN = managerToken;
  process.env.S8_PI_CONFIG_ROOT = path.join(root, 'pi');
  let managerSession;
  const session = (phase, prompt) => managerSession.prompt(`[${phase}] ${prompt}`, AbortSignal.timeout(120000));
  try {
    managerSession = await openManagerSession({ root, cwd: repo, directory, modelRuntime: runtime.runtime, model: runtime.model, poll: true });
    await session('manager-plan', `프로젝트 UID ${projectUid} 아래에 task 한 개를 생성하고 최종 계획을 delegate한 뒤 preflight_review를 기록하라. 사용자 요구사항은 최솟값 0, 음수 금지로 확정돼 있다. 추가 질문·실행 승인은 하지 않는다. spec: ${JSON.stringify(spec)}`);
    const created = await manager.list('task', projectUid);
    check('real manager created exactly one task', created.length === 1);
    taskUid = created[0].uid;
    let current;
    current = await manager.getWorkflow(taskUid);
    check('manager prepared final delegation without self-authorization', current.state === 'todo' && current.workflow?.spec && !current.workflow.grant);
    check('manager recorded resolved decisions on the work', Boolean((await manager.get(taskUid)).detail?.attributes.s8Preflight));
    if (humanLogin) { browser = await liveConsoleBrowser({ root, baseUrl, directory, login: humanLogin }); await browser.open(taskUid); }
    if (browser) {
      await browser.page.getByRole('checkbox', { name: '매니저와 논의한 최종 계획을 확인하고 이 버전으로 실행을 요청합니다.' }).check();
      await browser.operation('authorize', () => browser.page.getByRole('button', { name: '최종 계획 확정 · 실행' }).click());
    } else await human.workflow(taskUid, { action: 'authorize', planHash: current.workflow.planHash, message: 'Confirmed the discussed counter plan', expectedRevision: current.workflow.revision, requestId: randomUUID() });
    await ensureWorkerPool(root);
    const deadline = Date.now() + 600000;
    do {
      await developmentTick({ root, client: manager, policy, projectUid });
      current = await manager.getWorkflow(taskUid);
      if (['review', 'done', 'blocked', 'canceled'].includes(current.state)) break;
      await new Promise(resolve => setTimeout(resolve, 1000));
    } while (Date.now() < deadline);
    check('approved worker finished and awaits final review', ['review', 'done'].includes(current.state));
    await session('manager-result-review', `작업 ${taskUid}의 workflow_get 결과와 검증 근거를 확인하고 review_result로 검토 의견을 기록하라. complete는 사람이 처리한다.`);
    current = await manager.getWorkflow(taskUid);
    check('manager reviewed the result', Boolean(current.workflow.managerReview));
    if (browser) { await browser.page.reload(); await browser.operation('complete', () => browser.page.getByRole('button', { name: '결과 확인 · 작업 완료' }).click()); }
    else await human.workflow(taskUid, { action: 'complete', expectedRevision: current.workflow.revision, requestId: randomUUID(), message: 'Human checked the implementation and manager review' });
    current = await manager.getWorkflow(taskUid);
    check('human finalized the work', current.state === 'done');
    check('worker returned verification evidence', current.workflow.result?.verification?.length);
    const runId = current.workflow.run.id;
    const firstRequest = JSON.parse(await readFile(path.join(root, '.s8-runtime/runs', runId, 'request.json'), 'utf8'));
    if (browser) await browser.screenshot('completed-worker-result.png');
    check('original repository untouched', (await exec('git', ['status', '--porcelain'], { cwd: repo })).stdout === '');
    await managerSession.close();
    const managerSessionId = managerSession.sessionId;
    managerSession = undefined;
    const summary = { ok: true, scenario: 'approved-uid-worker-completion', managerSessionId, humanDecision: humanLogin ? 'authenticated isolated browser fixture' : 'authenticated isolated human fixture API', directory, taskUid, firstRunId: runId, worktree: firstRequest.run.workspace, evidence };
    await saveJson(path.join(directory, 'summary.json'), summary); return summary;
  } catch (error) { await saveJson(path.join(directory, 'summary.json'), { ok: false, directory, taskUid, evidence, failure: evidence.at(-1)?.name ?? 'Model or server failure' }); throw error; }
  finally {
    try { await managerSession?.close(); if (browser) await browser.close(); }
    finally { for (const [key, value] of Object.entries(previousEnv)) { if (value === undefined) delete process.env[key]; else process.env[key] = value; } }
  }
}
