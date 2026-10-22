// 매니저가 지정한 디렉터리에서 워커를 실행한다. Git 준비와 의존 결과 반영은 에이전트가 판단한다.
import { randomUUID } from 'node:crypto';
import path from 'node:path';
import { mkdir, realpath } from 'node:fs/promises';
import { projectmanFromEnv } from '../projectman/client.ts';
import { ensureSession, ensureWindow, quote, runTmux, windows } from '../runtime/tmux-windows.mjs';
import { dispatchClaim, readClaim } from './worker-run.mjs';

export const WORK_SESSION = 's8-workers';

export async function startWork(root, uid, { client = projectmanFromEnv(), run = runTmux, workerId = process.env.S8_WORKER_ID || 's8-developer' } = {}) {
  if (!/^[a-zA-Z0-9_-]{1,120}$/.test(uid ?? '')) throw new Error(`잘못된 UID입니다: ${uid}`);
  root = await realpath(root);
  const target = `${WORK_SESSION}:${uid}`;
  await ensureSession(run, root, WORK_SESSION);
  if ((await windows(run, WORK_SESSION)).some(window => window.name === uid && !window.dead)) return { uid, target, running: true };
  const task = await client.getWorkflow(uid);
  const source = task.workflow?.spec?.repoPath;
  const worktree = path.resolve(root, source ?? root);
  await mkdir(worktree, { recursive: true });
  const saved = await readClaim(root, uid);
  const resumed = Boolean(saved?.operation && saved.runId && !saved.reported && task.workflow?.run?.id === saved.runId);
  if (!resumed) {
    await dispatchClaim(root, { uid, operation: { action: 'claim', expectedRevision: task.workflow?.revision, requestId: randomUUID(), runId: randomUUID(), workerId } });
  }
  const command = ['bash', path.join(root, 'start-worker-agent.sh'), '--uid', uid, '--cwd', worktree].map(quote).join(' ');
  await ensureWindow(run, root, WORK_SESSION, uid, `S8_WORKER_ID=${quote(workerId)} exec ${command}`);
  return { uid, target, worktree, resumed, running: false };
}
