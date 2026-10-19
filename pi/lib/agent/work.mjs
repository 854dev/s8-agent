// 승인된 작업 하나를 워커로 실행한다(./s8.sh work UID, 매니저 run_worker 도구).
// 작업별 git worktree를 준비하고 선행 작업 결과를 적용한 뒤, claim 요청을 남기고 s8-workers 세션의 UID 창에서
// start-worker-agent.sh를 띄운다. claim·작업·보고는 워커가 직접 한다. 이미 claim한 작업이면 같은 worktree에서 이어간다.
import { randomUUID } from 'node:crypto';
import path from 'node:path';
import { realpath } from 'node:fs/promises';
import { projectmanFromEnv } from '../projectman/client.ts';
import { requireConfirmedPlan } from '../projectman/preflight.mjs';
import { prepareWorktree, importDevelopmentResults } from '../development/workspace.mjs';
import { ensureSession, ensureWindow, quote, runTmux, windows } from '../runtime/tmux-windows.mjs';
import { dispatchClaim, readClaim } from './worker-run.mjs';

export const WORK_SESSION = 's8-workers';

/** 선행 작업(dependsOn, 통합 작업의 완료된 하위 작업)의 결과 패치를 의존 순서대로 worktree에 적용하고 입력 트리를 돌려준다. */
async function importDependencies(root, client, uid, task, worktree) {
  const children = task.workflow.integration ? await client.list('subtask', uid) : [];
  const requested = [...(task.workflow.spec.dependsOn ?? []), ...children.filter(child => child.detail?.attributes.state === 'done').map(child => child.uid)];
  const ordered = [], visited = new Set();
  async function visit(dependencyUid) {
    if (visited.has(dependencyUid)) return;
    visited.add(dependencyUid);
    if (visited.size > 200) throw new Error('Dependency context too large');
    const dependency = await client.getWorkflow(dependencyUid);
    for (const prior of dependency.workflow?.spec?.dependsOn ?? []) await visit(prior);
    if (dependency.workflow?.spec?.repoPath === task.workflow.spec.repoPath) ordered.push(dependency);
  }
  for (const dependencyUid of requested) await visit(dependencyUid);
  return importDevelopmentResults({ root, worktree, tasks: ordered });
}

/** 워커를 실행하고 { uid, target, worktree, resumed, running }을 돌려준다. 같은 UID 창이 실행 중이면 그대로 둔다. */
export async function startWork(root, uid, { client = projectmanFromEnv(), run = runTmux, workerId = process.env.S8_WORKER_ID || 's8-developer' } = {}) {
  if (!/^[a-zA-Z0-9_-]{1,120}$/.test(uid ?? '')) throw new Error(`잘못된 UID입니다: ${uid}`);
  root = await realpath(root);
  const target = `${WORK_SESSION}:${uid}`;
  await ensureSession(run, root, WORK_SESSION);
  if ((await windows(run, WORK_SESSION)).some(window => window.name === uid && !window.dead)) return { uid, target, running: true };

  const task = await client.getWorkflow(uid);
  const saved = await readClaim(root, uid);
  const resumed = Boolean(saved?.revision && !saved.reported && task.state === 'doing' && task.workflow?.run?.id === saved.runId);
  let worktree;
  if (resumed) worktree = (await prepareWorktree({ root, uid, repoPath: task.workflow.spec.repoPath })).worktree;
  else {
    const assignee = task.workflow?.assignment?.assignee ?? task.workflow?.spec?.assignee;
    if (assignee && assignee !== workerId) throw new Error(`${assignee}에게 배정된 작업입니다(현재 워커: ${workerId}).`);
    if (task.workflow?.run?.status === 'running' || task.executionAllowed === false || task.state !== 'ready' || !task.workflow?.grant || task.workflow.review?.pending) throw new Error(`실행 가능한 상태가 아닙니다(state: ${task.state}). 사람이 계획을 확정한 ready 작업만 실행합니다.`);
    await requireConfirmedPlan(client, uid);
    const workspace = await prepareWorktree({ root, uid, repoPath: task.workflow.spec.repoPath });
    const inputTree = await importDependencies(root, client, uid, task, workspace.worktree);
    const runId = randomUUID();
    await dispatchClaim(root, { uid, operation: { action: 'claim', expectedRevision: task.workflow.revision, requestId: randomUUID(), runId, workerId }, inputTree, baseCommit: workspace.baseCommit });
    worktree = workspace.worktree;
  }
  const command = ['bash', path.join(root, 'start-worker-agent.sh'), '--uid', uid, '--cwd', worktree].map(quote).join(' ');
  await ensureWindow(run, root, WORK_SESSION, uid, `S8_WORKER_ID=${quote(workerId)} exec ${command}`);
  return { uid, target, worktree, resumed, running: false };
}
