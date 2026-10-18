import assert from 'node:assert/strict';
import http from 'node:http';
import path from 'node:path';
import os from 'node:os';
import { fileURLToPath } from 'node:url';
import { mkdtemp, mkdir, readFile, writeFile, rm } from 'node:fs/promises';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { randomUUID } from 'node:crypto';
import { ModelRuntime } from '@earendil-works/pi-coding-agent';
import { ProjectmanClient } from '../../../lib/projectman/client.ts';
import { startDeveloperWorker } from '../../../lib/development/worker-daemon.mjs';
import { executeDeveloper } from '../../../lib/development/worker-session.mjs';
import { developmentTick, waitForDevelopmentRuns, flushDevelopmentOutbox } from '../../../lib/development/supervisor.mjs';
import { drainManagerInbox } from '../../../lib/manager/inbox.mjs';
import { sendTelegram } from '../../../lib/telegram/notify.mjs';
import { liveConsoleBrowser } from '../../helpers/console-browser.mjs';

/** Full DB/HTTP/browser/SDK/socket flow; external model and Telegram accounts are never used. */
export async function exerciseProjectmanWorkerPool({ baseUrl, managerToken, workspaceUid, login }) {
  const sourceRoot = path.resolve(fileURLToPath(new URL('../../../..', import.meta.url)));
  const root = await mkdtemp(path.join(os.tmpdir(), 's8-full-worker-'));
  const repo = path.join(root, 'repo'), directory = path.join(root, 'evidence');
  const exec = promisify(execFile), client = new ProjectmanClient(baseUrl, managerToken);
  let browser, provider, workers = [];
  let workerError, providerError;
  const notifications = [];
  let telegramAttempts = 0, modelCalls = 0;
  try {
    await mkdir(repo); await mkdir(directory);
    await mkdir(path.join(root, 'pi')); await mkdir(path.join(root, 'agents/developer'), { recursive: true });
    await writeFile(path.join(root, 'pi/settings.json'), JSON.stringify({ defaultProvider: 's8-integration', defaultModel: 'fixture' }));
    await writeFile(path.join(root, 'agents/developer/WORKER_SYSTEM.md'), await readFile(path.join(sourceRoot, 'agents/developer/WORKER_SYSTEM.md'), 'utf8'));
    await writeFile(path.join(repo, 'base.txt'), 'original');
    for (const args of [['init'], ['add', '.'], ['-c', 'user.name=Fixture', '-c', 'user.email=fixture@example.invalid', 'commit', '-m', 'fixture']]) await exec('git', args, { cwd: repo });
    provider = http.createServer(async (req, res) => {
      try {
        let raw = ''; for await (const chunk of req) raw += chunk;
        const body = JSON.parse(raw);
        if (req.url === '/telegram') {
          telegramAttempts++;
          if (telegramAttempts === 1) { res.writeHead(503, { 'content-type': 'application/json' }); res.end(JSON.stringify({ ok: false, error_code: 503 })); return; }
          notifications.push(body);
          res.writeHead(200, { 'content-type': 'application/json' }); res.end(JSON.stringify({ ok: true, result: { message_id: 1 } })); return;
        }
        modelCalls++;
        const uid = /Assigned work UID: ([a-zA-Z0-9_-]+)/.exec(JSON.stringify(body.messages))?.[1];
        assert.ok(uid);
        const steps = [
          { name: 'projectman', args: { action: 'get', uid } },
          { name: 'write', args: { path: 'result.txt', content: 'worker-integration-ok' } },
          { name: 'bash', args: { command: 'test -f result.txt' } },
          { name: 'projectman', args: { action: 'report', uid, status: 'completed', summary: '파일 구현과 검증을 완료했습니다.', verification: [{ name: 'test', ok: true, summary: 'result.txt exists' }] } },
        ];
        const index = body.messages.filter(message => message.role === 'assistant' && message.tool_calls?.length).length;
        res.writeHead(200, { 'content-type': 'text/event-stream' });
        const emit = (delta, finish_reason = null) => res.write(`data: ${JSON.stringify({ id: `fixture-${modelCalls}`, object: 'chat.completion.chunk', model: 'fixture', choices: [{ index: 0, delta, finish_reason }] })}\n\n`);
        emit({ role: 'assistant' });
        if (steps[index]) {
          emit({ tool_calls: [{ index: 0, id: `call-${index}`, type: 'function', function: { name: steps[index].name, arguments: JSON.stringify(steps[index].args) } }] });
          emit({}, 'tool_calls');
        } else { emit({ content: '완료보고를 저장했습니다.' }); emit({}, 'stop'); }
        res.end('data: [DONE]\n\n');
      } catch (error) { providerError = error.message; res.writeHead(500); res.end('Local integration fixture failed'); }
    });
    await new Promise(resolve => provider.listen(0, '127.0.0.1', resolve));
    const providerUrl = `http://127.0.0.1:${provider.address().port}`;
    const runtime = await ModelRuntime.create({ authPath: path.join(root, 'fixture-auth.json'), modelsPath: null, refreshOnCreate: false });
    runtime.registerProvider('s8-integration', { api: 'openai-completions', apiKey: 'fixture-key', authHeader: true, baseUrl: `${providerUrl}/v1`, models: [{ id: 'fixture', name: 'Fixture', reasoning: false, input: ['text'], contextWindow: 32768, maxTokens: 1024, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 } }] });
    browser = await liveConsoleBrowser({ root: sourceRoot, runtimeRoot: root, baseUrl, directory, login });
    const settings = { telegram: { allowedUserIds: ['123456789'], allowedGroupIds: [], scheduleChatId: '123456789' }, workers: { count: 2 }, publicUrl: `${browser.origin}/s8/` };
    await writeFile(path.join(root, 's8-config.yml'), `telegram:\n  allowedUserIds: ["123456789"]\n  scheduleChatId: "123456789"\nworkers:\n  count: 2\npublicUrl: ${settings.publicUrl}\n`);
    const project = await client.create(workspaceUid, 'project', 'Worker integration', 'Disposable integration fixture', [], repo);
    const work = await client.create(project.uid, 'task', '브라우저 승인 워커 통합', '파일을 작성하고 검증하세요.');
    const delegated = await client.workflow(work.uid, { action: 'delegate', requestId: randomUUID(), expectedRevision: 0, spec: { repoPath: repo, plan: 'Write result.txt and verify it exists.', decisionRefs: ['fixture:approved-plan'], completionCriteria: ['result.txt exists'], commandNames: ['test'], dependsOn: [] } });
    await client.reviewPreflight(work.uid, delegated.workflow.revision, '요구사항과 검증 방법을 확정했습니다.');
    await browser.open(work.uid);
    await browser.page.getByRole('checkbox', { name: '매니저와 논의한 최종 계획을 확인하고 이 버전으로 실행을 요청합니다.' }).check();
    await browser.operation('authorize', () => browser.page.getByRole('button', { name: '최종 계획 확정 · 실행' }).click());
    assert.equal((await client.getWorkflow(work.uid)).state, 'ready');
    workers = await Promise.all(['worker-1', 'worker-2'].map(workerId => startDeveloperWorker(root, workerId, {
      executeWork: async (request, { signal }) => {
        try { return await executeDeveloper(request, { signal, client, runtimeFactory: async () => ({ runtime, model: runtime.getModel('s8-integration', 'fixture') }) }); }
        catch (error) { const events = await readFile(path.join(request.run.directory, 'developer.events.jsonl'), 'utf8').catch(() => 'No worker events'); workerError = { stack: `${error.stack}\nModel calls: ${modelCalls}; provider: ${providerError}\n${events}` }; throw error; }
      },
    })));
    const options = { root, client, policy: { maxConcurrency: 2 }, projectUid: project.uid };
    const deadline = Date.now() + 20000;
    let completed;
    do {
      await developmentTick(options);
      completed = await client.getWorkflow(work.uid);
      if (completed.state === 'review' || completed.state === 'blocked') break;
      await new Promise(resolve => setTimeout(resolve, 100));
    } while (Date.now() < deadline);
    await waitForDevelopmentRuns(root);
    assert.equal(completed.state, 'review', workerError?.stack ?? completed.workflow?.result?.summary);
    assert.equal(completed.workflow.run.workerId, 'worker-1');
    assert.equal(completed.workflow.runs.length, 1);
    const runId = completed.workflow.run.id;
    const runDirectory = path.join(root, '.s8-runtime/runs', runId);
    const request = JSON.parse(await readFile(path.join(runDirectory, 'request.json'), 'utf8'));
    assert.equal(await readFile(path.join(request.run.workspace, 'result.txt'), 'utf8'), 'worker-integration-ok');
    assert.ok((await readFile(path.join(runDirectory, 'changes.patch'), 'utf8')).includes('worker-integration-ok'));
    assert.equal((await exec('git', ['status', '--porcelain'], { cwd: repo })).stdout, '');
    await flushDevelopmentOutbox({ root, client, settings, notify: message => sendTelegram(message, { TELEGRAM_BOT_TOKEN: 'fixture-bot' }, (_url, init) => fetch(`${providerUrl}/telegram`, init), settings.telegram) });
    assert.match(notifications[0].text, /개발 완료 · 최종 확인 대기/);
    assert.equal(telegramAttempts, 2); assert.equal(notifications.length, 1);
    const link = notifications[0].text.split('\n').at(-1);
    assert.equal(new URL(link).searchParams.get('task'), work.uid);
    assert.equal(new URL(link).searchParams.get('run'), runId);
    const reports = [];
    await drainManagerInbox(root, report => reports.push(report));
    await drainManagerInbox(root, report => reports.push(report));
    assert.equal(reports.length, 1); assert.equal(reports[0].uid, work.uid); assert.equal(reports[0].state, 'review');
    await browser.page.context().clearCookies();
    await browser.page.goto(link);
    await browser.page.getByLabel('이메일', { exact: true }).fill(login.email);
    await browser.page.getByLabel('비밀번호', { exact: true }).fill(login.password);
    await browser.page.getByRole('button', { name: '로그인', exact: true }).click();
    await browser.page.getByRole('heading', { name: '개발 결과와 검증' }).waitFor();
    assert.equal(new URL(browser.page.url()).searchParams.get('run'), runId);
    assert.ok(await browser.page.getByRole('heading', { name: '개발 결과와 검증' }).locator('..').getByText('파일 구현과 검증을 완료했습니다.', { exact: true }).isVisible());
    assert.equal(await browser.page.getByRole('button', { name: '결과 확인 · 작업 완료' }).count(), 0);
    // A dependent work must remain unclaimable until the human finalizes its predecessor.
    const dependent = await client.create(project.uid, 'task', '선행 결과 통합', '최종 완료된 결과를 통합하세요.');
    const depPlan = await client.workflow(dependent.uid, { action: 'delegate', requestId: randomUUID(), expectedRevision: 0, spec: { repoPath: repo, plan: 'Integrate the completed predecessor.', decisionRefs: ['fixture:dependency'], completionCriteria: ['Predecessor finalized'], commandNames: [], dependsOn: [work.uid] } });
    await client.reviewPreflight(dependent.uid, depPlan.workflow.revision, '선행 작업의 최종 완료가 필요합니다.');
    await browser.page.goto(`${browser.origin}/s8/?task=${dependent.uid}`);
    await browser.page.getByRole('checkbox', { name: '매니저와 논의한 최종 계획을 확인하고 이 버전으로 실행을 요청합니다.' }).check();
    await browser.operation('authorize', () => browser.page.getByRole('button', { name: '최종 계획 확정 · 실행' }).click());
    const depReady = await client.getWorkflow(dependent.uid);
    const depClaim = { action: 'claim', requestId: randomUUID(), runId: randomUUID(), expectedRevision: depReady.workflow.revision, workerId: 'worker-2' };
    await assert.rejects(client.workflow(dependent.uid, depClaim), error => error.status === 409);
    await browser.page.goto(link);
    await client.workflow(work.uid, { action: 'review_result', expectedRevision: completed.workflow.revision, requestId: randomUUID(), message: '변경 패치와 파일 생성 검증 근거를 검토했습니다.' });
    await browser.page.reload();
    await browser.operation('complete', () => browser.page.getByRole('button', { name: '결과 확인 · 작업 완료' }).click());
    assert.equal((await client.getWorkflow(work.uid)).state, 'done');
    assert.equal((await client.workflow(dependent.uid, { ...depClaim, requestId: randomUUID() })).state, 'doing');
    return { ok: true, dependencyWaitVerified: true, humanCompletion: true, workUid: work.uid, runId, modelCalls, telegramAttempts, managerReports: reports.length, browserApproval: true, linkLoginPreserved: true };
  } finally {
    await Promise.all(workers.map(worker => worker.close()));
    await waitForDevelopmentRuns(root);
    await browser?.close();
    if (provider) { provider.closeAllConnections(); await new Promise(resolve => provider.close(resolve)); }
    await rm(root, { recursive: true, force: true });
  }
}
