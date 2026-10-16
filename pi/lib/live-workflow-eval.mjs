import { mkdir, mkdtemp, writeFile, readFile } from 'node:fs/promises';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import path from 'node:path';
import os from 'node:os';
import { randomUUID } from 'node:crypto';
import { ProjectmanClient } from './projectman-client.ts';
import { smokeRuntime, saveJson, SMOKE_DEPENDENCIES, SMOKE_DEV_DEPENDENCIES } from './development-smoke.mjs';
import { loadDevelopmentPolicy, developmentTick } from './development-supervisor.mjs';
import { liveConsoleBrowser } from './live-console-browser.mjs';
import { parallelWorkflowEval } from './parallel-workflow-eval.mjs';
import { openManagerSession } from './manager-session.mjs';

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
  const runtime = await smokeRuntime(), policy = await loadDevelopmentPolicy(root);
  const spec = { repoPath: repo, completionCriteria: ['React + Vite counter, current value aria-label="카운터"', 'Buttons exactly 증가, 감소, 초기화', 'Ask the human about the minimum before writing code; obey the recorded answer on resume', 'Existing independent tests and build pass'], allowedPaths: ['src', 'package-lock.json'], commandNames: ['install', 'test', 'build'], dependsOn: [], timeBudgetMinutes: 8 };
  let taskUid;
  let browser;
  const evidence = [];
  const check = (name, condition) => { evidence.push({ name, ok: Boolean(condition) }); if (!condition) throw new Error(name); };
  const system = await readFile(path.join(root, 'agents/manager/SYSTEM.md'), 'utf8');
  const previousEnv = Object.fromEntries(['PHCMS_API_URL', 'PHCMS_ACCESS_TOKEN', 'S8_PI_CONFIG_ROOT'].map(key => [key, process.env[key]]));
  // Only isolated fixture credentials; restore the process environment on every exit.
  process.env.PHCMS_API_URL = baseUrl;
  process.env.PHCMS_ACCESS_TOKEN = managerToken;
  process.env.S8_PI_CONFIG_ROOT = path.join(root, 'pi');
  let managerSession;
  const session = (phase, prompt) => managerSession.prompt(`[${phase}] ${prompt}`, AbortSignal.timeout(120000));
  const awaitManager = async predicate => {
    const deadline = Date.now() + 120000;
    while (Date.now() < deadline) {
      const fresh = await manager.getWorkflow(taskUid);
      if (predicate(fresh)) return fresh;
      await new Promise(resolve => setTimeout(resolve, 1000));
    }
    throw new Error('Automatic manager followup timed out');
  };
  try {
    managerSession = await openManagerSession({ root, cwd: repo, directory, modelRuntime: runtime.runtime, model: runtime.model, poll: true });
    await session('manager-plan', `프로젝트 UID ${projectUid} 아래에 type=task로 작업 한 개를 생성하라. 생성 응답의 uid를 이후 workflow 작업에 사용하라. 리액트 Vite 카운터를 만들어라. 감소 버튼의 최솟값 정책은 사람이 결정해야 하므로, 첫 개발 실행에서는 코드나 명령을 실행하기 전에 반드시 human 질문을 반환해야 한다. 사람이 답한 뒤 새 개발 실행에서 구현한다. 기존 테스트와 빌드 설정이 준비되어 있다. create로 작업을 등록한 뒤 workflow_get으로 revision을 읽고 delegate하라. 위임 spec: ${JSON.stringify(spec)}`);
    const created = await manager.list('task', projectUid);
    check('real manager created exactly one task', created.length === 1);
    taskUid = created[0].uid;
    let current = await manager.getWorkflow(taskUid);
    check('manager prepared delegation without self-authorization', current.workflow?.spec && !current.workflow.grant && current.state === 'todo');
    if (humanLogin) {
      browser = await liveConsoleBrowser({ root, baseUrl, directory, login: humanLogin });
      await browser.open(taskUid);
      await browser.page.getByRole('checkbox', { name: '위 저장소·파일·명령의 실행 범위를 확인했습니다.' }).check();
      await browser.operation('authorize', () => browser.page.getByRole('button', { name: '이 범위의 개발 실행 승인' }).click());
      check('real browser authorized visible execution scope', true);
    } else await human.workflow(taskUid, { action: 'authorize', expectedRevision: current.workflow.revision, requestId: randomUUID() });
    const first = await developmentTick({ root, client: manager, policy, allowedRoot: fixture });
    current = await manager.getWorkflow(taskUid);
    check('real developer CLI returned a human question', current.state === 'blocked' && current.workflow.review?.pending && current.workflow.review.audience === 'human');
    const firstRequest = JSON.parse(await readFile(path.join(root, '.s8-runtime/runs', first[0].runId, 'request.json'), 'utf8'));
    check('question stopped code changes', (await exec('git', ['status', '--porcelain'], { cwd: firstRequest.run.workspace })).stdout.trim() === '');
    const reviewId = current.workflow.review.id;
    if (browser) {
      await browser.page.getByRole('heading', { name: current.workflow.review.question, exact: true }).waitFor();
      await browser.page.getByLabel('내 답변', { exact: true }).fill('최솟값 0. 음수는 허용하지 않습니다. 기존 승인 범위 안에서 구현하세요.');
      await browser.operation('draft', () => browser.page.getByRole('button', { name: '답변 저장', exact: true }).click());
      await browser.screenshot('human-review-draft.png');
      check('real browser displays question and saves draft', true);
    } else await human.workflow(taskUid, { action: 'draft', expectedRevision: current.workflow.revision, requestId: randomUUID(), reviewId, answer: '최솟값 0. 음수는 허용하지 않습니다.' });
    check('draft does not execute development', (await developmentTick({ root, client: manager, policy, allowedRoot: fixture })).length === 0);
    current = await manager.getWorkflow(taskUid);
    if (browser) {
      await browser.page.getByRole('checkbox', { name: '답변과 승인 범위를 확인했습니다.' }).check();
      await browser.operation('decide', () => browser.page.getByRole('button', { name: '답변 확정 · 재개 요청' }).click());
      await browser.page.getByText('결정 확정 · 재개 대기', { exact: true }).waitFor();
      check('real browser sends a durable human resume signal', true);
    } else await human.workflow(taskUid, { action: 'decide', expectedRevision: current.workflow.revision, requestId: randomUUID(), reviewId, decision: 'resume', answer: '최솟값 0. 음수는 허용하지 않습니다. 기존 승인 범위 안에서 구현하세요.' });
    const beforeFollowup = await developmentTick({ root, client: manager, policy, allowedRoot: fixture });
    check('human signal waits for manager followup', beforeFollowup.every(item => item.status === 'idle'));
    current = await awaitManager(fresh => fresh.workflow.followup?.reviewId === reviewId);
    check('real manager automatically recorded followup bound to decision', current.workflow.followup?.reviewId === reviewId);
    const resumed = await developmentTick({ root, client: manager, policy, allowedRoot: fixture });
    current = await manager.getWorkflow(taskUid);
    check('new developer CLI implemented and verified counter', current.state === 'review' && current.workflow.result.status === 'completed' && ['test', 'build'].every(name => current.workflow.result.verification.some(item => item.name === name && item.ok)));
    check('resume signal bound to actual run', current.workflow.review.resumedRunId === resumed[0].runId);
    current = await awaitManager(fresh => Boolean(fresh.workflow.managerReview?.message));
    check('real manager automatically reviewed developer evidence', current.workflow.managerReview?.message);
    if (browser) {
      await browser.page.getByRole('button', { name: '결과 확인 · 작업 완료' }).waitFor();
      await browser.screenshot('verified-development-result.png');
      await browser.operation('complete', () => browser.page.getByRole('button', { name: '결과 확인 · 작업 완료' }).click());
      check('real browser accepts the reviewed development result', true);
    } else await human.workflow(taskUid, { action: 'complete', expectedRevision: current.workflow.revision, requestId: randomUUID(), message: 'Isolated test human accepted the verified counter.' });
    check('original repository untouched', (await exec('git', ['status', '--porcelain'], { cwd: repo })).stdout === '');
    // Stop polling before the independent benchmark's separately controlled manager stages.
    await managerSession.close();
    const managerSessionId = managerSession.sessionId;
    managerSession = undefined;
    const benchmark = await parallelWorkflowEval({ root, directory, repo, fixture, manager, human, projectUid, runtime, policy, systemPrompt: system });
    check('one manager delegated and collected two real parallel developers', benchmark.ok);
    const summary = { ok: true, scenario: 'real-server-real-model-human-fixture-resume', managerSessionId, humanDecision: humanLogin ? 'automated Chromium clicks by authenticated isolated human fixture' : 'authenticated isolated human fixture API', directory, taskUid, firstRunId: first[0].runId, resumedRunId: resumed[0].runId, worktree: firstRequest.run.workspace, benchmark, evidence };
    await saveJson(path.join(directory, 'summary.json'), summary); return summary;
  } catch (error) { await saveJson(path.join(directory, 'summary.json'), { ok: false, directory, taskUid, evidence, failure: evidence.at(-1)?.name ?? 'Model or server failure' }); throw error; }
  finally {
    try { await managerSession?.close(); if (browser) await browser.close(); }
    finally { for (const [key, value] of Object.entries(previousEnv)) { if (value === undefined) delete process.env[key]; else process.env[key] = value; } }
  }
}
