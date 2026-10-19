// 공유 서비스(scheduler, supervisor)와 개발 워커 풀 시작.
// 서비스는 체크아웃당 하나만 실행되며, 각 서비스 프로세스가 PID 잠금 파일로 이를 보장한다.
// 비정상 종료로 남은 잠금은 서비스가 시작할 때 스스로 정리한다(acquirePidLock).
import { mkdir, realpath } from 'node:fs/promises';
import path from 'node:path';
import { acquirePidLock, lockOwner, processAlive, sleep, waitUntil } from './process.mjs';
import { ensureWindow, stopWindow, windows, withTmuxLock, runTmux, quote, lockName } from './tmux-windows.mjs';
import { ensureWorkerPool, workersBusy } from '../development/worker-pool.mjs';

// 서비스별 PID 잠금 파일(저장소 루트 기준).
const lockFiles = {
  scheduler: '.s8-runtime/scheduler/owner.lock',
  supervisor: '.s8-runtime/services/supervisor.lock',
};

/** 서비스 창이 없는데 잠금 소유자가 살아 있으면 tmux 밖에서 실행 중인 것이므로 중복 실행을 거부한다. */
async function assertNoOutsideOwner(root, name) {
  const pid = await lockOwner(path.join(root, lockFiles[name]));
  if (processAlive(pid)) throw new Error(`${name}은 tmux 밖이나 이전 세션에서 실행 중입니다 (PID ${pid}). 기존 실행을 종료한 뒤 다시 실행하세요.`);
}

/** 서비스 창을 중지하고 프로세스가 잠금을 놓을 때까지 최대 5초 기다린다. */
async function stopService(run, root, session, name) {
  await stopWindow(run, root, session, name);
  const file = path.join(root, lockFiles[name]);
  let pid;
  const released = await waitUntil(async () => !processAlive(pid = await lockOwner(file)), { timeoutMs: 5000 });
  if (!released) throw new Error(`${name}의 기존 프로세스가 아직 실행 중입니다 (PID ${pid}).`);
}

/**
 * 공유 서비스를 (재)시작하고 서비스별 결과 목록을 돌려준다. supervisor를 켜면 워커 풀 결과({ service: 'workers' })도 포함한다.
 * session은 startPiRuntime이 만들고 소유를 확인한 런타임 세션이다. 실행 중인 서비스는 새 프로세스로 교체한다. 단, 워커가 작업 중이거나 워커 설정 적용이 보류되면
 * 실행 중인 supervisor는 그대로 둔다({ kept: true }).
 */
export async function startPiServices(root, { session = 's8-main', scheduler = true, supervisor = true, run = runTmux } = {}) {
  root = await realpath(root);
  if (!scheduler && !supervisor) return [];

  const results = [];
  let workerPool;
  if (supervisor) { workerPool = await ensureWorkerPool(root, { run }); results.push({ service: 'workers', ...workerPool }); }
  for (const [name, enabled] of Object.entries({ scheduler, supervisor })) {
    if (!enabled) continue;
    results.push(await withTmuxLock(run, lockName('s8-service-', root + name), async () => {
      const current = (await windows(run, session)).find(window => window.name === name);
      if (!current || current.dead) await assertNoOutsideOwner(root, name);
      else {
        if (name === 'supervisor' && (workerPool.deferred || await workersBusy(root))) return { service: name, session, window: name, kept: true };
        await stopService(run, root, session, name);
      }
      const result = await ensureWindow(run, root, session, name, `exec bash ${quote(path.join(root, 'start-pi.sh'))} --service ${name}`);
      // 잘못된 설정 등으로 즉시 종료되는 경우를 잡는다. 창은 남아 있어 오류 출력을 확인할 수 있다.
      await sleep(200);
      if ((await windows(run, session)).find(window => window.id === result.id)?.dead !== false) throw new Error(`${session}:${name}가 시작 직후 종료됐습니다. 해당 창에서 오류를 확인하세요.`);
      return { service: name, session, window: name };
    }));
  }
  return results;
}

/** 별도로 실행한 슈퍼바이저와 통합 실행의 중복도 같은 PID 잠금으로 차단한다. 반환값은 잠금 해제 함수. */
export async function supervisorOwner(root) {
  await mkdir(path.join(root, '.s8-runtime/services'), { recursive: true, mode: 0o700 });
  return acquirePidLock(path.join(root, lockFiles.supervisor));
}
