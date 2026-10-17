import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { Type } from 'typebox';
import { smokeSession, saveJson } from './development-smoke.mjs';
import { developmentTick } from './development-supervisor.mjs';

export async function parallelWorkflowEval({ root, directory, repo, fixture, manager, human, projectUid, runtime, policy, systemPrompt }) {
  const measurements = [];
  for (const mode of ['sequential', 'parallel']) {
    const ids = [], outputs = ['alpha', 'beta'].map(text => ({ text, file: `src/${mode}-${text}.txt` }));
    const tool = {
      name: 'projectman', label: 'Real Projectman', description: 'create, workflow_get, delegate, preflight_review, review_result for exactly two independent fixture tasks. Human authorization is not available.',
      parameters: Type.Object({ action: Type.Union(['create', 'workflow_get', 'delegate', 'preflight_review', 'review_result'].map(value => Type.Literal(value))), uid: Type.Optional(Type.String()), title: Type.Optional(Type.String()), text: Type.Optional(Type.String()), spec: Type.Optional(Type.Unknown()), expectedRevision: Type.Optional(Type.Integer()), message: Type.Optional(Type.String()) }),
      async execute(_id, args) {
        let response;
        if (args.action === 'create') { if (ids.length >= 2) throw new Error('Only two tasks'); response = await manager.create(projectUid, 'task', args.title, args.text); ids.push(response.uid); response = { uid: response.uid, revision: 0, state: 'todo' }; }
        else {
          if (!ids.includes(args.uid)) throw new Error('Use a task ID returned by create');
          if (args.action === 'workflow_get') response = await manager.getWorkflow(args.uid);
          else if (args.action === 'preflight_review') response = await manager.reviewPreflight(args.uid, args.expectedRevision, args.message);
          else {
            if (!Number.isInteger(args.expectedRevision)) throw new Error('Read revision first; a new workflow has revision 0');
            response = await manager.workflow(args.uid, { action: args.action, expectedRevision: args.expectedRevision, requestId: randomUUID(), ...(args.action === 'delegate' ? { spec: args.spec } : { message: args.message }) });
          }
        }
        return { content: [{ type: 'text', text: JSON.stringify(response) }], details: undefined };
      },
    };
    const plans = outputs.map(output => ({ title: `Independent ${mode} ${output.text}`, text: `Write the file ${output.file} with exactly ${output.text} (optional trailing newline). This is a fully decided independent task: no questions and no command execution are needed.`, spec: { repoPath: repo, completionCriteria: [`${output.file} contains exactly ${output.text}`], allowedPaths: [output.file], commandNames: [], dependsOn: [], timeBudgetMinutes: 3 } }));
    const invoke = (role, prompt) => smokeSession({ ...runtime, role, prompt, systemPrompt, tools: [tool], run: { directory, workspace: repo }, signal: AbortSignal.timeout(120000) });
    await invoke(`manager-${mode}-plan`, `아래 두 개의 독립 작업을 각각 create하고 delegate하라. 총 2개 모두 위임하고 workflow_get으로 revision을 조회한 뒤 preflight_review로 확정 요구사항·허용 범위·검증 방법을 기록해야 한다. spec과 텍스트를 그대로 사용하고 작업 생성 응답의 uid와 revision을 전달한다. 승인과 실행은 평가 감독자가 담당한다.\n${JSON.stringify(plans)}`);
    if (ids.length !== 2) throw new Error('Manager did not prepare two independent tasks');
    const tasks = await Promise.all(ids.map(uid => manager.getWorkflow(uid)));
    if (new Set(tasks.map(task => task.workflow?.spec?.allowedPaths?.[0])).size !== 2) throw new Error('Independent scopes must be distinct');
    for (let i = 0; i < tasks.length; i++) {
      const task = tasks[i];
      const plan = plans.find(plan => plan.spec.allowedPaths[0] === task.workflow?.spec?.allowedPaths?.[0]);
      if (!plan || JSON.stringify(task.workflow.spec.allowedPaths) !== JSON.stringify(plan.spec.allowedPaths) || task.workflow.spec.repoPath !== repo || task.workflow.spec.commandNames.length || task.workflow.spec.dependsOn.length || task.workflow.grant) throw new Error('Manager changed an independent task scope');
      await human.workflow(task.uid, { action: 'authorize', expectedRevision: task.workflow.revision, requestId: randomUUID() });
    }
    const started = Date.now();
    const runs = await developmentTick({ root, client: manager, allowedRoot: fixture, policy: { ...policy, maxConcurrency: mode === 'parallel' ? 2 : 1, perRepoConcurrency: mode === 'parallel' ? 2 : 1 } });
    const elapsedMs = Date.now() - started;
    const current = await Promise.all(ids.map(uid => manager.getWorkflow(uid)));
    if (runs.length !== 2 || current.some(task => task.state !== 'review')) throw new Error('Independent developer runs did not finish');
    let tokens = 0;
    const intervals = [];
    for (let i = 0; i < ids.length; i++) {
      const run = runs.find(run => run.uid === ids[i]);
      const expected = outputs.find(output => output.file === current[i].workflow.spec.allowedPaths[0]);
      if (!expected || (await readFile(path.join(run.worktree, expected.file), 'utf8')).trim() !== expected.text) throw new Error('Independent output failed quality check');
      const frames = (await readFile(path.join(root, '.s8-runtime/runs', run.runId, 'developer.events.jsonl'), 'utf8')).trim().split('\n').map(JSON.parse);
      tokens += frames.filter(event => event.type === 'assistant').reduce((sum, event) => sum + Object.values(event.usage ?? {}).reduce((subtotal, value) => subtotal + Number(value), 0), 0);
      intervals.push({ uid: ids[i], started: Date.parse(current[i].workflow.run.startedAt), finished: Date.parse(current[i].workflow.run.finishedAt) });
    }
    const overlap = Math.max(...intervals.map(item => item.started)) < Math.min(...intervals.map(item => item.finished));
    if (overlap !== (mode === 'parallel')) throw new Error('Actual execution intervals did not match the concurrency policy');
    await invoke(`manager-${mode}-review`, `아래 두 작업의 workflow_get 결과를 각각 확인하고 review_result를 남겨라. 개발 결과를 단순 합치지 말고 각 작업의 완료 조건·변경 파일·검증 유무를 확인하라. 작업 ID: ${ids.join(', ')}`);
    for (const uid of ids) {
      const task = await manager.getWorkflow(uid);
      if (!task.workflow.managerReview) throw new Error('Manager did not collect both results');
      await human.workflow(uid, { action: 'complete', expectedRevision: task.workflow.revision, requestId: randomUUID(), message: 'Fixture independently checked exact file contents.' });
    }
    measurements.push({ mode, elapsedMs, modelTokens: tokens, outputsPassed: 2, overlap, runs: runs.map(item => ({ uid: item.uid, runId: item.runId })), intervals });
  }
  const result = { ok: true, sampleSize: 1, note: 'Same model and equivalent independent tasks. This is one measured sample, not a general performance guarantee. Token counts are provider-reported usage; no monetary cost estimate.', measurements };
  await saveJson(path.join(directory, 'parallel-benchmark.json'), result); return result;
}
